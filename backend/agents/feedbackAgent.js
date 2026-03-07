// agents/feedbackAgent.js — ReplyMate Pro v8.1
// Handles a single negative/neutral feedback end-to-end.
// Called by the poller for each new feedback case.
//
// Pipeline per feedback:
//   1. Load order details + message thread (parallel)
//   2. Classify root cause (mini, ~$0.00018)
//   3. Generate public reply — 75-80 chars exactly (mini, ~$0.00027)
//   4. Generate private buyer message if no prior chat (mini, ~$0.00016)
//   5. In auto mode: send immediately. In draft mode: save, notify seller.

const fetch      = require('node-fetch');
const supabase   = require('../db/supabase');
const {
  getOrderMessages,
  getOrderDetails,
  postFeedbackReply,
  sendBuyerMessage
} = require('../lib/ebayFeedbackClient');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

async function miniCall(system, user, maxTokens = 200) {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch(OPENAI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({
      model:       'gpt-4o-mini',
      messages:    [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens:  maxTokens,
      temperature: 0.4
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content.trim();
}

async function miniCallJSON(system, user, maxTokens = 300) {
  const raw = await miniCall(system, user, maxTokens);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

// ── Classify root cause ────────────────────────────────────────────────────
async function classifyRootCause({ feedback, order, thread, instructions }) {
  const threadSummary = thread.length
    ? thread.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.text.slice(0, 150)}`).join('\n')
    : 'No prior messages';

  const orderSummary = order
    ? `Order ${order.orderId} | Status: ${order.status} | Created: ${order.createdDate} | Items: ${order.items?.map(i => i.title).join(', ')}`
    : 'No order data';

  const instrBlock = buildInstructionsBlock(instructions);
  const result = await miniCallJSON(
    `You are an eBay seller analyst. Classify the root cause of this negative feedback and assess risk.${instrBlock ? '\n' + instrBlock : ''}\nReturn ONLY valid JSON.`,
    `FEEDBACK: "${feedback.comment}"
RATING: ${feedback.rating}
ITEM: ${feedback.itemTitle}
${orderSummary}
THREAD SUMMARY:
${threadSummary}

Return:
{
  "rootCause": "late_delivery|not_as_described|no_response|damaged|wrong_item|other",
  "rootCauseExplanation": "<one sentence>",
  "buyerFrustration": "<what the buyer is actually angry about in plain English>",
  "sellerAtFault": <true|false>,
  "defectRisk": "<low|medium|high>",
  "highStakes": <true|false>,
  "highStakesReason": "<null or reason — e.g. 'case already opened', 'high value order', 'legal language'>",
  "suggestedResolution": "<refund|replacement|apology_only|partial_refund|investigate>"
}`
  );

  return result || {
    rootCause: 'other',
    rootCauseExplanation: 'Could not classify',
    buyerFrustration: feedback.comment,
    sellerAtFault: false,
    defectRisk: 'low',
    highStakes: false,
    highStakesReason: null,
    suggestedResolution: 'apology_only'
  };
}

// ── Generate public feedback reply (75-80 chars) ───────────────────────────
async function generatePublicReply({ feedback, classification, sellerName, instructions }) {
  const biz = sellerName || 'us';

  const instrBlock = buildInstructionsBlock(instructions);
  const reply = await miniCall(
    `You write public eBay feedback replies for sellers.${instrBlock ? '\n' + instrBlock : ''}
CRITICAL RULES:
- Reply must be EXACTLY 75-80 characters including spaces. Count carefully.
- Never admit fault, never promise refunds, never mention specific order details
- Sound human, empathetic, professional — not robotic
- Always end with an offer to resolve: "please message us", "contact us", etc.
- Do NOT start with "Hi" or the buyer's name — eBay shows this publicly
- Output ONLY the reply text, nothing else`,
    `ROOT CAUSE: ${classification.rootCause}
BUYER FRUSTRATION: ${classification.buyerFrustration}
SELLER AT FAULT: ${classification.sellerAtFault}
FEEDBACK: "${feedback.comment}"
SELLER NAME: ${biz}

Write a 75-80 character public feedback reply. Count every character.`,
    100
  );

  // Enforce 80 char hard limit, try to keep above 75
  const trimmed = reply.replace(/^["']|["']$/g, '').trim().slice(0, 80);
  return trimmed;
}

// ── Generate private buyer message ─────────────────────────────────────────
async function generatePrivateMessage({ feedback, classification, order, sellerName, businessName, instructions }) {
  const sign = sellerName || 'The Team';
  const biz  = businessName || 'our store';

  const instrBlock = buildInstructionsBlock(instructions);
  return await miniCall(
    `You write private eBay messages from sellers to buyers after a negative feedback.${instrBlock ? '\n' + instrBlock : ''}
RULES:
- Empathetic, personal, not copy-paste sounding
- Acknowledge the specific issue they mentioned
- Offer a concrete resolution based on root cause
- Never sound defensive or blame the buyer
- Never suggest off-eBay contact
- End with seller name
- 80-150 words`,
    `SELLER: ${sign} from ${biz}
BUYER FEEDBACK: "${feedback.comment}"
ITEM: ${feedback.itemTitle || 'the item'}
ROOT CAUSE: ${classification.rootCause}
BUYER FRUSTRATION: ${classification.buyerFrustration}
SUGGESTED RESOLUTION: ${classification.suggestedResolution}
ORDER DATE: ${order?.createdDate || 'unknown'}
HAD PRIOR CHAT: false — this is first contact since the issue

Write a personal private message to the buyer.`,
    300
  );
}

// ── Generate revision request message (sent after resolution, 3+ days later) ──
async function generateRevisionRequest({ feedback, resolution, sellerName, instructions }) {
  const sign = sellerName || 'The Team';

  const instrBlock = buildInstructionsBlock(instructions);
  return await miniCall(
    `You write polite eBay feedback revision requests.${instrBlock ? '\n' + instrBlock : ''}
RULES:
- Reference the resolution that happened
- Be genuine, not pushy — make it easy to say yes
- One request only, no guilt-tripping
- Short: 40-60 words
- End with seller name`,
    `SELLER: ${sign}
ORIGINAL FEEDBACK: "${feedback.comment}"
RESOLUTION PROVIDED: ${resolution}

Write a short feedback revision request message.`,
    150
  );
}

// ── Main agent — process one feedback case ─────────────────────────────────
// ── Build personalisation block from user's plain-English instructions ────
function buildInstructionsBlock(instructions) {
  if (!instructions || !instructions.trim()) return '';
  return `
━━━ SELLER'S PERSONAL INSTRUCTIONS (HIGHEST PRIORITY) ━━━
The seller has configured specific rules for this agent. Follow these ABOVE all default behaviour.
If instructions conflict with eBay platform rules (e.g. financial promises in a public reply),
apply the instruction in the private message instead — never ignore it entirely.

"${instructions.trim()}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

async function processFeedbackCase(feedbackCase, user) {
  const { id: caseId, ebay_feedback_id, ebay_order_id, feedback_comment, item_title, feedback_rating } = feedbackCase;
  const mode = user.feedback_agent_mode || 'draft';

  console.log(`[feedbackAgent] Processing ${feedbackCase.ebay_feedback_id} | mode=${mode}`);

  // Mark as processing
  await supabase.from('feedback_cases').update({ status: 'processing' }).eq('id', caseId);

  try {
    // ── Stage 1: Gather context (parallel) ────────────────────────────
    const [orderData, threadData] = await Promise.all([
      ebay_order_id ? getOrderDetails(user.id, ebay_order_id) : Promise.resolve(null),
      ebay_order_id ? getOrderMessages(user.id, ebay_order_id) : Promise.resolve({ ok: true, messages: [], hadChat: false })
    ]);

    const hadPriorChat = threadData.hadChat || false;
    const thread       = threadData.messages || [];

    const feedback = {
      feedbackId:    ebay_feedback_id,
      comment:       feedback_comment || '',
      itemTitle:     item_title || '',
      rating:        feedback_rating,
      orderId:       ebay_order_id
    };

    // ── Stage 2: Classify ─────────────────────────────────────────────
    const classification = await classifyRootCause({ feedback, order: orderData, thread, instructions: user.feedback_agent_instructions });

    // ── High-stakes check — skip autonomous, flag for human ──────────
    if (classification.highStakes) {
      await supabase.from('feedback_cases').update({
        root_cause:          classification.rootCause,
        had_prior_chat:      hadPriorChat,
        status:              'skipped',
        skip_reason:         classification.highStakesReason,
        updated_at:          new Date().toISOString()
      }).eq('id', caseId);
      console.log(`[feedbackAgent] Skipped (high-stakes): ${classification.highStakesReason}`);
      return { ok: true, status: 'skipped', reason: classification.highStakesReason };
    }

    // ── Stage 3: Generate replies (parallel) ─────────────────────────
    const [publicReply, privateMsg] = await Promise.all([
      generatePublicReply({ feedback, classification, sellerName: user.business_name || user.name, instructions: user.feedback_agent_instructions }),
      (!hadPriorChat)
        ? generatePrivateMessage({ feedback, classification, order: orderData, sellerName: user.signature_name || user.name, businessName: user.business_name, instructions: user.feedback_agent_instructions })
        : Promise.resolve(null)
    ]);

    // ── Save to DB ────────────────────────────────────────────────────
    await supabase.from('feedback_cases').update({
      root_cause:       classification.rootCause,
      had_prior_chat:   hadPriorChat,
      defect_created:   classification.defectRisk === 'high',
      public_reply:     publicReply,
      private_message:  privateMsg,
      mode,
      status:           mode === 'auto' ? 'replied' : 'draft_ready',
      updated_at:       new Date().toISOString()
    }).eq('id', caseId);

    // ── Auto mode: send immediately ───────────────────────────────────
    if (mode === 'auto') {
      const replyResult = await postFeedbackReply(user.id, ebay_feedback_id, publicReply);
      if (replyResult.ok) {
        await supabase.from('feedback_cases').update({
          public_reply_sent:    true,
          public_reply_sent_at: new Date().toISOString()
        }).eq('id', caseId);
      }

      if (privateMsg && !hadPriorChat && ebay_order_id) {
        const msgResult = await sendBuyerMessage(user.id, ebay_order_id, privateMsg);
        if (msgResult.ok) {
          await supabase.from('feedback_cases').update({
            private_message_sent:    true,
            private_message_sent_at: new Date().toISOString(),
            status: 'messaged'
          }).eq('id', caseId);
        }
      }

      console.log(`[feedbackAgent] Auto-sent reply for ${ebay_feedback_id}`);
      return { ok: true, status: 'sent', publicReply, privateMsg };
    }

    // ── Draft mode: just notify ───────────────────────────────────────
    console.log(`[feedbackAgent] Draft ready for ${ebay_feedback_id}`);
    return { ok: true, status: 'draft_ready', publicReply, privateMsg, classification };

  } catch (err) {
    console.error('[feedbackAgent] Error:', err.message);
    await supabase.from('feedback_cases').update({
      status:        'error',
      error_message: err.message,
      updated_at:    new Date().toISOString()
    }).eq('id', caseId);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  processFeedbackCase,
  generateRevisionRequest,
  classifyRootCause
};
