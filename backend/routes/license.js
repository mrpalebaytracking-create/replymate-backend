// routes/license.js — Validate license keys, enforce plan limits
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ── GET /license/validate — called by extension on startup ────────────────
// Header: x-license-key: RM-XXXX-XXXX-XXXX-XXXX
router.get('/validate', async (req, res) => {
  const licenseKey = req.headers['x-license-key'];
  if (!licenseKey) return res.status(401).json({ valid: false, reason: 'no_key' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end, name, business_name, signature_name, reply_tone')
    .eq('license_key', licenseKey)
    .single();

  if (error || !user) {
    return res.status(401).json({ valid: false, reason: 'invalid_key' });
  }

  // Update last_active
  await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('license_key', licenseKey);

  // Check plan status
  const now = new Date();

  // ── OWNER PLAN — never expires, full access, no billing ─────────────────
  if (user.plan === 'owner') {
    return res.json({
      valid: true,
      plan: 'owner',
      trial_days_left: null,
      user_name: user.name,
      max_accounts: 99,
      settings: {
        business_name: user.business_name,
        signature_name: user.signature_name,
        reply_tone: user.reply_tone
      }
    });
  }

  if (user.plan === 'trial') {
    const trialEnd = new Date(user.trial_end);
    if (now > trialEnd) {
      // Trial expired
      await supabase.from('users').update({ plan: 'expired' }).eq('license_key', licenseKey);
      return res.json({
        valid: false,
        reason: 'trial_expired',
        upgrade_url: `${process.env.LANDING_URL}/#pricing`
      });
    }
    const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
    return res.json({
      valid: true,
      plan: 'trial',
      trial_days_left: daysLeft,
      user_name: user.name,
      settings: {
        business_name: user.business_name,
        signature_name: user.signature_name,
        reply_tone: user.reply_tone
      }
    });
  }

  if (user.plan === 'expired') {
    return res.json({
      valid: false,
      reason: 'trial_expired',
      upgrade_url: `${process.env.LANDING_URL}/#pricing`
    });
  }

  if (user.plan === 'pro' || user.plan === 'agency') {
    // Check Stripe subscription is active
    if (user.subscription_status === 'canceled') {
      const subEnd = user.subscription_end ? new Date(user.subscription_end) : null;
      if (subEnd && now > subEnd) {
        return res.json({ valid: false, reason: 'subscription_canceled', upgrade_url: `${process.env.LANDING_URL}/#pricing` });
      }
    }
    if (user.subscription_status === 'past_due') {
      return res.json({ valid: true, plan: user.plan, warning: 'payment_failed', message: 'Payment failed — update your card to keep access' });
    }

    return res.json({
      valid: true,
      plan: user.plan,
      max_accounts: user.plan === 'agency' ? 3 : 1,
      user_name: user.name,
      settings: {
        business_name: user.business_name,
        signature_name: user.signature_name,
        reply_tone: user.reply_tone
      }
    });
  }

  return res.json({ valid: false, reason: 'unknown_plan' });
});

module.exports = router;
