// routes/stripe.js — Stripe checkout + webhooks
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const supabase = require('../db/supabase');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── POST /stripe/create-checkout — create Stripe checkout session ─────────
// Body: { license_key, plan: 'pro' | 'agency', success_url, cancel_url }
router.post('/create-checkout', async (req, res) => {
  const { license_key, plan, email } = req.body;

  if (!license_key || !plan) return res.status(400).json({ error: 'license_key and plan required' });

  // Get user
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, stripe_customer_id')
    .eq('license_key', license_key)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const priceId = plan === 'agency'
    ? process.env.STRIPE_AGENCY_PRICE_ID
    : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId || priceId.includes('REPLACE')) {
    return res.status(500).json({ error: 'Stripe price IDs not configured yet. Create products in Stripe dashboard.' });
  }

  // Get or create Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { license_key, user_id: user.id }
    });
    customerId = customer.id;
    await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.CUSTOMER_DASHBOARD_URL}/billing?success=true&plan=${plan}`,
    cancel_url: `${process.env.LANDING_URL}/#pricing`,
    subscription_data: {
      metadata: { license_key, user_id: user.id, plan }
    },
    allow_promotion_codes: true
  });

  res.json({ checkout_url: session.url });
});

// ── POST /stripe/create-portal — billing portal (manage/cancel) ───────────
router.post('/create-portal', async (req, res) => {
  const { license_key } = req.body;

  const { data: user } = await supabase
    .from('users')
    .select('stripe_customer_id')
    .eq('license_key', license_key)
    .single();

  if (!user?.stripe_customer_id) return res.status(404).json({ error: 'No billing account found' });

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${process.env.CUSTOMER_DASHBOARD_URL}/billing`
  });

  res.json({ portal_url: session.url });
});

// ── POST /stripe/webhook — Stripe sends events here ───────────────────────
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  switch (event.type) {

    // ── Payment succeeded → unlock account ─────────────────────────────
    case 'checkout.session.completed': {
      const { license_key, plan } = data.subscription_data?.metadata || data.metadata || {};
      if (!license_key) break;

      const subscription = await stripe.subscriptions.retrieve(data.subscription);
      const periodEnd = new Date(subscription.current_period_end * 1000);

      await supabase.from('users').update({
        plan: plan || 'pro',
        stripe_subscription_id: data.subscription,
        subscription_status: 'active',
        subscription_end: periodEnd.toISOString()
      }).eq('license_key', license_key);

      console.log(`✓ Activated ${plan} for ${license_key}`);
      break;
    }

    // ── Subscription renewed ────────────────────────────────────────────
    case 'invoice.payment_succeeded': {
      const subId = data.subscription;
      if (!subId) break;

      const subscription = await stripe.subscriptions.retrieve(subId);
      const { license_key } = subscription.metadata || {};
      if (!license_key) break;

      const periodEnd = new Date(subscription.current_period_end * 1000);
      await supabase.from('users').update({
        subscription_status: 'active',
        subscription_end: periodEnd.toISOString()
      }).eq('license_key', license_key);
      break;
    }

    // ── Payment failed ──────────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const subId = data.subscription;
      if (!subId) break;
      const subscription = await stripe.subscriptions.retrieve(subId);
      const { license_key } = subscription.metadata || {};
      if (license_key) {
        await supabase.from('users').update({ subscription_status: 'past_due' }).eq('license_key', license_key);
      }
      break;
    }

    // ── Subscription canceled ───────────────────────────────────────────
    case 'customer.subscription.deleted': {
      const { license_key } = data.metadata || {};
      if (!license_key) break;
      const periodEnd = data.current_period_end ? new Date(data.current_period_end * 1000) : new Date();
      await supabase.from('users').update({
        subscription_status: 'canceled',
        subscription_end: periodEnd.toISOString()
      }).eq('license_key', license_key);
      console.log(`✓ Canceled subscription for ${license_key}`);
      break;
    }

    // ── Plan changed (upgrade/downgrade) ────────────────────────────────
    case 'customer.subscription.updated': {
      const { license_key } = data.metadata || {};
      if (!license_key) break;
      // Detect plan from price ID
      const priceId = data.items?.data?.[0]?.price?.id;
      let plan = 'pro';
      if (priceId === process.env.STRIPE_AGENCY_PRICE_ID) plan = 'agency';
      await supabase.from('users').update({
        plan,
        subscription_status: data.status
      }).eq('license_key', license_key);
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
