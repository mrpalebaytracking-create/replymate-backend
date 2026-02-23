// routes/customer.js — Customer-facing dashboard API
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });
  const { data: user } = await supabase.from('users').select('*').eq('license_key', key).single();
  if (!user) return res.status(401).json({ error: 'Invalid license key' });
  req.user = user;
  next();
}

// ── GET /customer/profile ─────────────────────────────────────────────────
router.get('/profile', requireLicense, async (req, res) => {
  const u = req.user;
  const daysLeft = u.plan === 'trial'
    ? Math.max(0, Math.ceil((new Date(u.trial_end) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;

  const { data: ebayAccounts } = await supabase
    .from('ebay_accounts')
    .select('ebay_username, is_primary, created_at')
    .eq('user_id', u.id);

  res.json({
    name: u.name,
    email: u.email,
    business_name: u.business_name,
    plan: u.plan,
    trial_days_left: daysLeft,
    trial_end: u.trial_end,
    subscription_status: u.subscription_status,
    subscription_end: u.subscription_end,
    max_accounts: u.plan === 'agency' ? 3 : 1,
    ebay_accounts: ebayAccounts || [],
    created_at: u.created_at
  });
});

// ── PUT /customer/profile — update settings ───────────────────────────────
router.put('/profile', requireLicense, async (req, res) => {
  const { name, business_name, signature_name, reply_tone } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (business_name !== undefined) updates.business_name = business_name;
  if (signature_name !== undefined) updates.signature_name = signature_name;
  if (reply_tone !== undefined) updates.reply_tone = reply_tone;

  await supabase.from('users').update(updates).eq('id', req.user.id);
  res.json({ success: true });
});

// ── GET /customer/tone-samples ────────────────────────────────────────────
router.get('/tone-samples', requireLicense, async (req, res) => {
  const { data } = await supabase
    .from('tone_samples')
    .select('id, text, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  res.json({ samples: data || [] });
});

// ── POST /customer/tone-samples ───────────────────────────────────────────
router.post('/tone-samples', requireLicense, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  await supabase.from('tone_samples').insert({ user_id: req.user.id, text: text.slice(0, 5000) });
  res.json({ success: true });
});

// ── DELETE /customer/tone-samples/:id ────────────────────────────────────
router.delete('/tone-samples/:id', requireLicense, async (req, res) => {
  await supabase.from('tone_samples').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// ── GET /customer/saved-convos ────────────────────────────────────────────
router.get('/saved-convos', requireLicense, async (req, res) => {
  const { data } = await supabase
    .from('saved_convos')
    .select('id, buyer_name, customer_message, reply, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  res.json({ convos: data || [] });
});

// ── POST /customer/saved-convos ───────────────────────────────────────────
router.post('/saved-convos', requireLicense, async (req, res) => {
  const { buyer_name, customer_message, reply } = req.body;
  await supabase.from('saved_convos').insert({
    user_id: req.user.id,
    buyer_name: buyer_name || 'Unknown',
    customer_message: (customer_message || '').slice(0, 2000),
    reply: (reply || '').slice(0, 2000)
  });
  res.json({ success: true });
});

module.exports = router;
