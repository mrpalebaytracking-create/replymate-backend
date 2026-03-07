// routes/feedback.js — ReplyMate Pro v8.1
// All feedback agent API endpoints consumed by the extension.

const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const { postFeedbackReply, sendBuyerMessage, requestFeedbackRevision } = require('../lib/ebayFeedbackClient');
const { runPollCycle } = require('../lib/feedbackPoller');

// ── Auth middleware (same as reply.js) ────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });
  const { data: user } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end, name, business_name, signature_name, feedback_agent_mode, feedback_agent_active, feedback_agent_instructions')
    .eq('license_key', key)
    .single();
  if (!user) return res.status(401).json({ error: 'Invalid license key' });
  req.user = user;
  next();
}

// ── GET /feedback/settings ────────────────────────────────────────────────
// Returns current agent mode + active state
router.get('/settings', requireLicense, async (req, res) => {
  res.json({
    success:      true,
    mode:         req.user.feedback_agent_mode   || 'draft',
    active:       req.user.feedback_agent_active || false,
    instructions: req.user.feedback_agent_instructions || ''
  });
});

// ── POST /feedback/settings ───────────────────────────────────────────────
// Toggle mode (auto/draft/off) and active state
router.post('/settings', requireLicense, async (req, res) => {
  const { mode, active, instructions } = req.body;
  const validModes = ['auto', 'draft', 'off'];
  if (mode && !validModes.includes(mode))
    return res.status(400).json({ error: 'Invalid mode. Use: auto, draft, off' });

  const updates = {};
  if (mode         !== undefined) updates.feedback_agent_mode         = mode;
  if (active       !== undefined) updates.feedback_agent_active       = active;
  if (instructions !== undefined) updates.feedback_agent_instructions = instructions.trim().slice(0, 2000) || null;

  await supabase.from('users').update(updates).eq('id', req.user.id);
  res.json({ success: true, mode: mode || req.user.feedback_agent_mode, active: active ?? req.user.feedback_agent_active, instructions: updates.feedback_agent_instructions ?? req.user.feedback_agent_instructions ?? '' });
});

// ── GET /feedback/cases ───────────────────────────────────────────────────
// Returns feedback cases — optional ?status=draft_ready for pending approvals
router.get('/cases', requireLicense, async (req, res) => {
  const { status, limit = 20, offset = 0 } = req.query;

  let query = supabase
    .from('feedback_cases')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load cases' });
  res.json({ success: true, cases: data || [], total: data?.length || 0 });
});

// ── GET /feedback/cases/:id ───────────────────────────────────────────────
router.get('/cases/:id', requireLicense, async (req, res) => {
  const { data, error } = await supabase
    .from('feedback_cases')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Case not found' });
  res.json({ success: true, case: data });
});

// ── POST /feedback/cases/:id/approve ─────────────────────────────────────
// Draft mode: seller approves a draft — sends public reply + private message
router.post('/cases/:id/approve', requireLicense, async (req, res) => {
  const { data: fbCase } = await supabase
    .from('feedback_cases')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (!fbCase) return res.status(404).json({ error: 'Case not found' });
  if (fbCase.status !== 'draft_ready') return res.status(400).json({ error: 'Case is not in draft_ready state' });

  const results = { publicReply: null, privateMessage: null };
  const user    = req.user;

  // Send public feedback reply
  if (fbCase.public_reply && !fbCase.public_reply_sent) {
    const result = await postFeedbackReply(user.id, fbCase.ebay_feedback_id, fbCase.public_reply);
    results.publicReply = result.ok ? 'sent' : result.error;
    if (result.ok) {
      await supabase.from('feedback_cases').update({
        public_reply_sent:    true,
        public_reply_sent_at: new Date().toISOString()
      }).eq('id', fbCase.id);
    }
  }

  // Send private buyer message
  if (fbCase.private_message && !fbCase.private_message_sent && fbCase.ebay_order_id) {
    const result = await sendBuyerMessage(user.id, fbCase.ebay_order_id, fbCase.private_message);
    results.privateMessage = result.ok ? 'sent' : result.error;
    if (result.ok) {
      await supabase.from('feedback_cases').update({
        private_message_sent:    true,
        private_message_sent_at: new Date().toISOString()
      }).eq('id', fbCase.id);
    }
  }

  await supabase.from('feedback_cases').update({
    draft_approved:    true,
    draft_approved_at: new Date().toISOString(),
    status:            fbCase.private_message ? 'messaged' : 'replied'
  }).eq('id', fbCase.id);

  res.json({ success: true, results });
});

// ── POST /feedback/cases/:id/reject ──────────────────────────────────────
// Draft mode: seller rejects draft (does nothing, marks as rejected)
router.post('/cases/:id/reject', requireLicense, async (req, res) => {
  await supabase.from('feedback_cases').update({
    draft_rejected: true,
    status:         'skipped',
    skip_reason:    'seller_rejected'
  }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── PUT /feedback/cases/:id/reply ─────────────────────────────────────────
// Edit the AI-generated reply before approving
router.put('/cases/:id/reply', requireLicense, async (req, res) => {
  const { public_reply, private_message } = req.body;

  if (public_reply && public_reply.length > 80)
    return res.status(400).json({ error: 'Public reply must be 80 characters or less' });

  const updates = {};
  if (public_reply    !== undefined) updates.public_reply    = public_reply;
  if (private_message !== undefined) updates.private_message = private_message;

  await supabase.from('feedback_cases').update(updates).eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// ── POST /feedback/cases/:id/revision ────────────────────────────────────
// Manually trigger a revision request
router.post('/cases/:id/revision', requireLicense, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const { data: fbCase } = await supabase
    .from('feedback_cases')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (!fbCase) return res.status(404).json({ error: 'Case not found' });
  if (fbCase.revision_requested) return res.status(400).json({ error: 'Revision already requested — eBay allows only one request per feedback' });

  const result = fbCase.ebay_order_id
    ? await requestFeedbackRevision(req.user.id, fbCase.ebay_feedback_id, message)
    : { ok: false, error: 'No order ID' };

  await supabase.from('feedback_cases').update({
    revision_requested:    true,
    revision_requested_at: new Date().toISOString(),
    status:                'revision_sent'
  }).eq('id', fbCase.id);

  res.json({ success: true, sent: result.ok, error: result.error || null });
});

// ── GET /feedback/analytics ───────────────────────────────────────────────
router.get('/analytics', requireLicense, async (req, res) => {
  const { data: analytics } = await supabase
    .from('feedback_analytics')
    .select('*')
    .eq('user_id', req.user.id)
    .order('period_start', { ascending: false })
    .limit(6); // last 6 months

  // Also get at-risk orders count
  const { count: atRiskCount } = await supabase
    .from('at_risk_orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('message_sent', false);

  // Pending draft cases
  const { count: draftCount } = await supabase
    .from('feedback_cases')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('status', 'draft_ready');

  res.json({
    success:       true,
    analytics:     analytics || [],
    atRiskPending: atRiskCount || 0,
    draftsPending: draftCount || 0
  });
});

// ── GET /feedback/at-risk ─────────────────────────────────────────────────
router.get('/at-risk', requireLicense, async (req, res) => {
  const { data } = await supabase
    .from('at_risk_orders')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('message_sent', false)
    .order('risk_score', { ascending: false });
  res.json({ success: true, orders: data || [] });
});

// ── POST /feedback/at-risk/:id/approve ───────────────────────────────────
router.post('/at-risk/:id/approve', requireLicense, async (req, res) => {
  const { data: order } = await supabase
    .from('at_risk_orders')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (!order) return res.status(404).json({ error: 'Not found' });

  const result = await sendBuyerMessage(req.user.id, order.ebay_order_id, order.message_text);
  if (result.ok) {
    await supabase.from('at_risk_orders').update({
      message_sent:    true,
      message_sent_at: new Date().toISOString()
    }).eq('id', order.id);
  }
  res.json({ success: result.ok, error: result.error || null });
});

// ── POST /feedback/poll ───────────────────────────────────────────────────
// Manual trigger for testing / immediate poll
router.post('/poll', requireLicense, async (req, res) => {
  // Fire and forget — don't wait for it
  runPollCycle().catch(err => console.error('[manual poll] error:', err.message));
  res.json({ success: true, message: 'Poll cycle started' });
});

module.exports = router;
