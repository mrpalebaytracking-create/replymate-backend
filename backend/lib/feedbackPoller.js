// lib/feedbackPoller.js — ReplyMate Pro v8.1
// Runs every 3 hours via setInterval started from index.js.
// Polls eBay feedback for all users who have the agent active,
// creates feedback_cases rows, triggers processFeedbackCase() for each new one.
// Also runs pre-emptive at-risk order detection.

const supabase        = require('../db/supabase');
const { getFeedbackReceived, getAtRiskOrders, sendBuyerMessage } = require('./ebayFeedbackClient');
const { processFeedbackCase, classifyRootCause }                 = require('../agents/feedbackAgent');

const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ── Pre-emptive messaging agent ───────────────────────────────────────────
const fetch = require('node-fetch');

async function generateAtRiskMessage({ order, sellerName, businessName }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const sign = sellerName || 'The Team';
  const biz  = businessName || 'our store';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({
      model:       'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You write proactive eBay seller messages to buyers about delayed/untracked orders. Be friendly, reassuring, apologetic. 60-80 words. End with seller name. Never suggest off-eBay contact.` },
        { role: 'user',   content: `SELLER: ${sign} from ${biz}\nITEM: ${order.itemTitle}\nRISK REASON: ${order.riskReason}\nOrder age context: This order is taking longer than expected.\n\nWrite a proactive message to the buyer before they complain.` }
      ],
      max_tokens:  180,
      temperature: 0.5
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Neutral sentiment analysis ────────────────────────────────────────────
async function analyseNeutralSentiment(comment) {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({
      model:    'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Analyse eBay neutral feedback for warning signals. Return ONLY JSON.' },
        { role: 'user',   content: `NEUTRAL FEEDBACK: "${comment}"\n\nReturn: {"warningSignals": ["<signal>"], "atRiskOfNegative": <true|false>, "urgentAction": "<null or action>"}` }
      ],
      max_tokens:  120,
      temperature: 0.2
    })
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content.replace(/```json|```/g, '').trim());
  } catch {
    return { warningSignals: [], atRiskOfNegative: false, urgentAction: null };
  }
}

// ── Update root cause analytics ───────────────────────────────────────────
async function updateAnalytics(userId, classification) {
  const today      = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const monthEnd   = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: existing } = await supabase
    .from('feedback_analytics')
    .select('*')
    .eq('user_id', userId)
    .eq('period_start', monthStart)
    .single();

  const rootCauses = existing?.root_causes || {};
  rootCauses[classification.rootCause] = (rootCauses[classification.rootCause] || 0) + 1;

  if (existing) {
    await supabase.from('feedback_analytics').update({
      total_negative:  existing.total_negative + 1,
      defects_created: existing.defects_created + (classification.defectRisk === 'high' ? 1 : 0),
      root_causes:     rootCauses,
      updated_at:      new Date().toISOString()
    }).eq('id', existing.id);
  } else {
    await supabase.from('feedback_analytics').insert({
      user_id:         userId,
      period_start:    monthStart,
      period_end:      monthEnd,
      total_negative:  1,
      total_neutral:   0,
      defects_created: classification.defectRisk === 'high' ? 1 : 0,
      root_causes:     rootCauses
    });
  }
}

// ── Main poll function (runs per user) ───────────────────────────────────
async function pollUserFeedback(user) {
  console.log(`[poller] Polling feedback for user ${user.id}`);

  // ── 1. Fetch new feedbacks from eBay ─────────────────────────────────
  const { ok, feedbacks } = await getFeedbackReceived(user.id, { days: 7, limit: 50 });
  if (!ok || !feedbacks.length) {
    await supabase.from('users').update({ feedback_last_polled: new Date().toISOString() }).eq('id', user.id);
    return;
  }

  let newCount = 0;
  for (const fb of feedbacks) {
    // Skip if we already have this feedback
    const { data: existing } = await supabase
      .from('feedback_cases')
      .select('id, status')
      .eq('user_id', user.id)
      .eq('ebay_feedback_id', fb.feedbackId)
      .single();

    if (existing) continue;

    // Insert new case
    const { data: newCase } = await supabase.from('feedback_cases').insert({
      user_id:           user.id,
      ebay_feedback_id:  fb.feedbackId,
      ebay_order_id:     fb.orderId,
      buyer_username:    fb.buyerUsername,
      feedback_rating:   fb.rating,
      feedback_comment:  fb.comment,
      feedback_date:     fb.date,
      item_title:        fb.itemTitle,
      item_price:        fb.itemPrice,
      mode:              user.feedback_agent_mode || 'draft',
      status:            'pending'
    }).select().single();

    if (!newCase) continue;
    newCount++;

    // Neutral feedback: analyse sentiment but don't auto-reply
    if (fb.rating === 'neutral') {
      const sentiment = await analyseNeutralSentiment(fb.comment);
      await supabase.from('feedback_cases').update({
        root_cause: sentiment.atRiskOfNegative ? 'at_risk_neutral' : 'neutral_ok',
        status:     sentiment.atRiskOfNegative ? 'draft_ready' : 'skipped',
        skip_reason: sentiment.atRiskOfNegative ? null : 'neutral_low_risk',
        public_reply: sentiment.urgentAction || null
      }).eq('id', newCase.id);
      continue;
    }

    // Negative feedback: run full agent
    const result = await processFeedbackCase(newCase, user);
    if (result.ok && result.classification) {
      await updateAnalytics(user.id, result.classification);
    }
  }

  // ── 2. Pre-emptive at-risk order check ───────────────────────────────
  const atRiskOrders = await getAtRiskOrders(user.id);
  for (const order of atRiskOrders) {
    // Skip if already messaged
    const { data: existing } = await supabase
      .from('at_risk_orders')
      .select('id')
      .eq('user_id', user.id)
      .eq('ebay_order_id', order.orderId)
      .single();

    if (existing) continue;

    // Insert at-risk record
    const { data: riskRecord } = await supabase.from('at_risk_orders').insert({
      user_id:       user.id,
      ebay_order_id: order.orderId,
      buyer_username: order.buyerUsername,
      item_title:    order.itemTitle,
      risk_reason:   order.riskReason,
      risk_score:    order.riskScore
    }).select().single();

    if (!riskRecord) continue;

    // In auto mode: send pre-emptive message immediately
    if (user.feedback_agent_mode === 'auto') {
      const msg = await generateAtRiskMessage({
        order,
        sellerName:   user.signature_name || user.name,
        businessName: user.business_name
      });
      if (msg) {
        const sendResult = await sendBuyerMessage(user.id, order.orderId, msg);
        if (sendResult.ok) {
          await supabase.from('at_risk_orders').update({
            message_sent:    true,
            message_sent_at: new Date().toISOString(),
            message_text:    msg
          }).eq('id', riskRecord.id);
        }
      }
    } else {
      // Draft mode: save message for approval
      const msg = await generateAtRiskMessage({ order, sellerName: user.signature_name || user.name, businessName: user.business_name });
      await supabase.from('at_risk_orders').update({ message_text: msg }).eq('id', riskRecord.id);
    }
  }

  // ── 3. Revision request check (3+ days since last message) ───────────
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: revisionCandidates } = await supabase
    .from('feedback_cases')
    .select('*')
    .eq('user_id', user.id)
    .eq('revision_requested', false)
    .eq('revision_resolved', false)
    .in('status', ['messaged', 'replied'])
    .eq('private_message_sent', true)
    .lt('private_message_sent_at', threeDaysAgo);

  for (const c of (revisionCandidates || [])) {
    // Generate revision request
    const { generateRevisionRequest } = require('../agents/feedbackAgent');
    const msg = await generateRevisionRequest({
      feedback:     { comment: c.feedback_comment, feedbackId: c.ebay_feedback_id },
      resolution:   'The issue has been resolved',
      sellerName:   user.signature_name || user.name,
      instructions: user.feedback_agent_instructions || null
    });

    await supabase.from('feedback_cases').update({
      revision_requested:    true,
      revision_requested_at: new Date().toISOString(),
      status:                'revision_sent'
    }).eq('id', c.id);

    if (user.feedback_agent_mode === 'auto' && c.ebay_order_id) {
      await sendBuyerMessage(user.id, c.ebay_order_id, msg);
    }
  }

  await supabase.from('users').update({ feedback_last_polled: new Date().toISOString() }).eq('id', user.id);
  console.log(`[poller] Done for ${user.id}: ${newCount} new feedback(s) processed`);
}

// ── Global poller — runs for all active users ────────────────────────────
async function runPollCycle() {
  console.log(`[poller] Starting poll cycle at ${new Date().toISOString()}`);

  const { data: users } = await supabase
    .from('users')
    .select('id, name, business_name, signature_name, feedback_agent_mode, feedback_agent_active, feedback_agent_instructions')
    .eq('feedback_agent_active', true)
    .neq('feedback_agent_mode', 'off');

  if (!users?.length) {
    console.log('[poller] No active users to poll');
    return;
  }

  // Process users sequentially to avoid eBay API rate limits
  for (const user of users) {
    try {
      await pollUserFeedback(user);
    } catch (err) {
      console.error(`[poller] Error for user ${user.id}:`, err.message);
    }
    // Small delay between users
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[poller] Poll cycle complete`);
}

// ── Start the poller ──────────────────────────────────────────────────────
function startFeedbackPoller() {
  console.log(`[poller] Feedback agent starting — polling every 3 hours`);
  runPollCycle().catch(err => console.error('[poller] Initial cycle error:', err.message));
  setInterval(() => {
    runPollCycle().catch(err => console.error('[poller] Cycle error:', err.message));
  }, POLL_INTERVAL_MS);
}

module.exports = { startFeedbackPoller, runPollCycle };
