// routes/admin.js — Owner dashboard API (protected by ADMIN_SECRET)
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ── Admin auth middleware ─────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── GET /admin/overview — main metrics ────────────────────────────────────
router.get('/overview', requireAdmin, async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // User counts by plan
  const { data: usersByPlan } = await supabase
    .from('users')
    .select('plan');

  const planCounts = { trial: 0, pro: 0, agency: 0, expired: 0 };
  (usersByPlan || []).forEach(u => { planCounts[u.plan] = (planCounts[u.plan] || 0) + 1; });

  const activeSubscribers = planCounts.pro + planCounts.agency;
  const mrr = (planCounts.pro * 19) + (planCounts.agency * 49);

  // New signups this month
  const { count: newThisMonth } = await supabase
    .from('users')
    .select('id', { count: 'exact' })
    .gte('created_at', monthStart);

  // New signups last month
  const { count: newLastMonth } = await supabase
    .from('users')
    .select('id', { count: 'exact' })
    .gte('created_at', lastMonthStart)
    .lte('created_at', lastMonthEnd);

  // Total usage this month
  const { data: monthlyUsage } = await supabase
    .from('usage')
    .select('replies_count, cost_usd')
    .gte('date', monthStart.split('T')[0]);

  const monthlyTotals = (monthlyUsage || []).reduce((acc, r) => ({
    replies: acc.replies + (r.replies_count || 0),
    ai_cost: acc.ai_cost + parseFloat(r.cost_usd || 0)
  }), { replies: 0, ai_cost: 0 });

  // Active users last 7 days
  const { count: activeWeek } = await supabase
    .from('users')
    .select('id', { count: 'exact' })
    .gte('last_active', weekAgo);

  // Signups per day last 14 days
  const { data: signupData } = await supabase
    .from('users')
    .select('created_at')
    .gte('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true });

  const signupsByDay = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    signupsByDay[d] = 0;
  }
  (signupData || []).forEach(u => {
    const d = u.created_at.split('T')[0];
    if (signupsByDay[d] !== undefined) signupsByDay[d]++;
  });

  res.json({
    plan_counts: planCounts,
    active_subscribers: activeSubscribers,
    mrr,
    total_users: Object.values(planCounts).reduce((a, b) => a + b, 0),
    new_this_month: newThisMonth || 0,
    new_last_month: newLastMonth || 0,
    monthly_replies: monthlyTotals.replies,
    monthly_ai_cost: parseFloat(monthlyTotals.ai_cost.toFixed(4)),
    monthly_revenue: mrr,
    monthly_profit: parseFloat((mrr - monthlyTotals.ai_cost).toFixed(2)),
    active_last_7_days: activeWeek || 0,
    signups_by_day: signupsByDay
  });
});

// ── GET /admin/customers — all customers list ─────────────────────────────
router.get('/customers', requireAdmin, async (req, res) => {
  const { page = 1, limit = 30, plan, search } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('users')
    .select('id, email, name, plan, trial_end, subscription_status, subscription_end, created_at, last_active, business_name, ebay_username', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (plan) query = query.eq('plan', plan);
  if (search) query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Get this month usage for each customer
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const userIds = (data || []).map(u => u.id);

  const { data: usageData } = await supabase
    .from('usage')
    .select('user_id, replies_count, cost_usd')
    .in('user_id', userIds)
    .gte('date', monthStart);

  const usageByUser = {};
  (usageData || []).forEach(u => {
    if (!usageByUser[u.user_id]) usageByUser[u.user_id] = { replies: 0, cost: 0 };
    usageByUser[u.user_id].replies += u.replies_count || 0;
    usageByUser[u.user_id].cost += parseFloat(u.cost_usd || 0);
  });

  const customers = (data || []).map(u => ({
    ...u,
    monthly_replies: usageByUser[u.id]?.replies || 0,
    monthly_ai_cost: parseFloat((usageByUser[u.id]?.cost || 0).toFixed(5)),
    revenue: u.plan === 'pro' ? 19 : u.plan === 'agency' ? 49 : 0,
    profit: u.plan === 'pro' ? parseFloat((19 - (usageByUser[u.id]?.cost || 0)).toFixed(2)) :
            u.plan === 'agency' ? parseFloat((49 - (usageByUser[u.id]?.cost || 0)).toFixed(2)) : 0,
    days_left: u.plan === 'trial' ? Math.max(0, Math.ceil((new Date(u.trial_end) - new Date()) / (1000 * 60 * 60 * 24))) : null
  }));

  res.json({ customers, total: count || 0, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /admin/ai-costs — AI cost breakdown ───────────────────────────────
router.get('/ai-costs', requireAdmin, async (req, res) => {
  const days = parseInt(req.query.days || 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { data: dailyCosts } = await supabase
    .from('usage')
    .select('date, cost_usd, rule_count, mini_count, large_count, replies_count')
    .gte('date', since)
    .order('date', { ascending: true });

  // Aggregate by date
  const byDate = {};
  (dailyCosts || []).forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { cost: 0, rule: 0, mini: 0, large: 0, total: 0 };
    byDate[r.date].cost += parseFloat(r.cost_usd || 0);
    byDate[r.date].rule += r.rule_count || 0;
    byDate[r.date].mini += r.mini_count || 0;
    byDate[r.date].large += r.large_count || 0;
    byDate[r.date].total += r.replies_count || 0;
  });

  const totalCost = Object.values(byDate).reduce((a, b) => a + b.cost, 0);
  const pro = await supabase.from('users').select('id', { count: 'exact' }).eq('plan', 'pro');
  const agency = await supabase.from('users').select('id', { count: 'exact' }).eq('plan', 'agency');
  const monthlyRevenue = (pro.count || 0) * 19 + (agency.count || 0) * 49;

  res.json({
    total_cost: parseFloat(totalCost.toFixed(4)),
    total_revenue: monthlyRevenue,
    profit: parseFloat((monthlyRevenue - totalCost).toFixed(2)),
    margin_pct: monthlyRevenue > 0 ? parseFloat(((1 - totalCost / monthlyRevenue) * 100).toFixed(1)) : 100,
    daily: Object.entries(byDate).map(([date, data]) => ({ date, ...data, cost: parseFloat(data.cost.toFixed(5)) }))
  });
});

// ── GET /admin/intents — what are customers asking most ───────────────────
router.get('/intents', requireAdmin, async (req, res) => {
  const days = parseInt(req.query.days || 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('reply_log')
    .select('intent')
    .gte('created_at', since);

  const counts = {};
  (data || []).forEach(r => { counts[r.intent] = (counts[r.intent] || 0) + 1; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([intent, count]) => ({ intent, count, pct: total > 0 ? parseFloat(((count / total) * 100).toFixed(1)) : 0 }));

  res.json({ intents: sorted, total, days });
});

module.exports = router;
