// routes/auth.js — User registration, login, license keys
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../db/supabase');

// ── Generate a unique license key ─────────────────────────────────────────
function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [8, 4, 4, 4].map(len =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  );
  return 'RM-' + segments.join('-');
}

// ── POST /auth/register — called when seller installs extension ───────────
// Body: { email, name, business_name }
router.post('/register', async (req, res) => {
  const { email, name, business_name } = req.body;

  if (!email) return res.status(400).json({ error: 'Email required' });

  // Check if already registered
  const { data: existing } = await supabase
    .from('users')
    .select('id, license_key, plan, trial_end')
    .eq('email', email.toLowerCase())
    .single();

  if (existing) {
    // Return existing account info
    const daysLeft = Math.max(0, Math.ceil((new Date(existing.trial_end) - new Date()) / (1000 * 60 * 60 * 24)));
    return res.json({
      success: true,
      isNew: false,
      license_key: existing.license_key,
      plan: existing.plan,
      trial_days_left: existing.plan === 'trial' ? daysLeft : null,
      message: 'Welcome back to ReplyMate Pro'
    });
  }

  // Create new user with 14-day trial
  const license_key = generateLicenseKey();
  const trial_end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const { data: user, error } = await supabase
    .from('users')
    .insert({
      email: email.toLowerCase(),
      name: name || '',
      business_name: business_name || '',
      license_key,
      plan: 'trial',
      trial_start: new Date().toISOString(),
      trial_end: trial_end.toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Registration failed', details: error.message });
  }

  // TODO: Send welcome email via Resend when you add that key

  res.json({
    success: true,
    isNew: true,
    license_key: user.license_key,
    plan: 'trial',
    trial_days_left: 14,
    message: 'Welcome to ReplyMate Pro! Your 14-day free trial has started.'
  });
});

// ── POST /auth/lookup — get account by email (for login) ─────────────────
router.post('/lookup', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, license_key, plan, trial_end, name, business_name')
    .eq('email', email.toLowerCase())
    .single();

  if (error || !user) return res.status(404).json({ error: 'Account not found' });

  const daysLeft = user.plan === 'trial'
    ? Math.max(0, Math.ceil((new Date(user.trial_end) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;

  res.json({
    success: true,
    license_key: user.license_key,
    plan: user.plan,
    trial_days_left: daysLeft,
    name: user.name
  });
});

module.exports = router;
