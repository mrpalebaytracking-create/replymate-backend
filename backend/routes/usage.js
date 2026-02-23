// routes/usage.js — Track reply usage per user
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ── Middleware: verify license key ────────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });

  const { data: user } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end')
    .eq('license_key', key)
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid license key' });

  // Owner account is always valid
  if (user.plan === 'owner') { req.user = user; return next(); }

  // Check if active
  const now = new Date();
  if (user.plan === 'trial' && now > new Date(user.trial_end)) {
    return res.status(403).json({ error: 'trial_expired', upgrade_url: `${process.env.LANDING_URL}/#pricing` });
  }
  if (user.plan === 'expired') {
    return res.status(403).json({ error: 'trial_expired', upgrade_url: `${process.env.LANDING_URL}/#pricing` });
  }
  if (user.plan !== 'trial' && user.subscription_status === 'canceled') {
    if (user.subscription_end && now > new Date(user.subscription_end)) {
      return res.status(403).json({ error: 'subscription_ended', upgrade_url: `${process.env.LANDING_URL}/#pricing` });
    }
  }

  req.user = user;
  next();
}

// ── POST /usage/track — log a reply (called by extension after each reply) ─
// Body: { route, model, intent, tokens, cost_usd, latency_ms, customer_message, generated_reply, source }
router.post('/track', requireLicense, async (req, res) => {
  const { route, model, intent, tokens, cost_usd, latency_ms,
          customer_message, generated_reply, modify_instructions, source } = req.body;
  const today = new Date().toISOString().split('T')[0];

  // Upsert daily usage
  const { error: usageError } = await supabase.rpc('increment_usage', {
    p_user_id: req.user.id,
    p_date: today,
    p_route: route || 'rule',
    p_tokens: tokens || 0,
    p_cost: cost_usd || 0
  }).catch(() => ({ error: null }));

  // Fallback if RPC doesn't exist yet — direct upsert
  const { data: existing } = await supabase
    .from('usage')
    .select('id, replies_count, rule_count, mini_count, large_count, tokens_used, cost_usd')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .single();

  if (existing) {
    await supabase.from('usage').update({
      replies_count: existing.replies_count + 1,
      rule_count: existing.rule_count + (route === 'rule' ? 1 : 0),
      mini_count: existing.mini_count + (route === 'mini' ? 1 : 0),
      large_count: existing.large_count + (route === 'large' ? 1 : 0),
      tokens_used: existing.tokens_used + (tokens || 0),
      cost_usd: parseFloat(existing.cost_usd) + (cost_usd || 0)
    }).eq('id', existing.id);
  } else {
    await supabase.from('usage').insert({
      user_id: req.user.id,
      date: today,
      replies_count: 1,
      rule_count: route === 'rule' ? 1 : 0,
      mini_count: route === 'mini' ? 1 : 0,
      large_count: route === 'large' ? 1 : 0,
      tokens_used: tokens || 0,
      cost_usd: cost_usd || 0
    });
  }

  // Log individual reply
  await supabase.from('reply_log').insert({
    user_id: req.user.id,
    intent: intent || 'general',
    route: route || 'rule',
    model: model || 'unknown',
    customer_message: (customer_message || '').slice(0, 2000),
    generated_reply: (generated_reply || '').slice(0, 2000),
    modify_instructions: modify_instructions || null,
    latency_ms: latency_ms || 0,
    tokens_used: tokens || 0,
    cost_usd: cost_usd || 0,
    source: source || 'dom'
  });

  res.json({ success: true });
});

// ── GET /usage/summary — get this month's usage for customer dashboard ────
router.get('/summary', requireLicense, async (req, res) => {
  const userId = req.user.id;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  // Monthly totals
  const { data: monthly } = await supabase
    .from('usage')
    .select('replies_count, tokens_used, cost_usd')
    .eq('user_id', userId)
    .gte('date', monthStart);

  const totals = (monthly || []).reduce((acc, row) => ({
    replies: acc.replies + (row.replies_count || 0),
    tokens: acc.tokens + (row.tokens_used || 0),
    cost: acc.cost + parseFloat(row.cost_usd || 0)
  }), { replies: 0, tokens: 0, cost: 0 });

  // Last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data: daily } = await supabase
    .from('usage')
    .select('date, replies_count, cost_usd')
    .eq('user_id', userId)
    .gte('date', sevenDaysAgo)
    .order('date', { ascending: true });

  // Intent breakdown
  const { data: intents } = await supabase
    .from('reply_log')
    .select('intent')
    .eq('user_id', userId)
    .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  const intentCounts = {};
  (intents || []).forEach(r => {
    intentCounts[r.intent] = (intentCounts[r.intent] || 0) + 1;
  });

  // All-time totals
  const { data: allTime } = await supabase
    .from('usage')
    .select('replies_count, cost_usd')
    .eq('user_id', userId);

  const allTotals = (allTime || []).reduce((acc, row) => ({
    replies: acc.replies + (row.replies_count || 0),
    cost: acc.cost + parseFloat(row.cost_usd || 0)
  }), { replies: 0, cost: 0 });

  res.json({
    this_month: totals,
    all_time: allTotals,
    daily_last_7: daily || [],
    top_intents: Object.entries(intentCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  });
});

// ── GET /usage/history — reply history with pagination ───────────────────
router.get('/history', requireLicense, async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('reply_log')
    .select('id, intent, route, model, customer_message, generated_reply, status, source, cost_usd, created_at', { count: 'exact' })
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`customer_message.ilike.%${search}%,generated_reply.ilike.%${search}%`);
  }

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ replies: data || [], total: count || 0, page: parseInt(page), limit: parseInt(limit) });
});

module.exports = router;
