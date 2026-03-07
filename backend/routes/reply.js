// routes/reply.js — ReplyMate Pro v5.0
// Advanced 7-Agent Pipeline — 4 consolidated API calls
//
// ARCHITECTURE:
//   CALL 1 (GPT-4o):      Agent 0 (Pre-Processor) + Agent 1 (Classifier)
//   Agent 2 (no AI):       Data Fetch (eBay API)
//   CALL 2 (GPT-4o-mini):  Agent 3 (Risk) + Agent 4 (Profit Protection)
//   CALL 3 (GPT-4o-mini):  Agent 5 (Reasoning / Strategy Brief)
//   CALL 4 (GPT-4o):       Agent 6 (Writer) + Agent 7 (Validator)
//
// Junior Agent runs after Call 1 (Option B) — smart gating using conversation state.
// Full synchronization via shared pipeline context object throughout.

const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../db/supabase');

// ── New agent imports ────────────────────────────────────────────────────
const { preClassifyAgent }   = require('../agents/preClassifyAgent');
const { dataFetchAgent }     = require('../agents/dataFetchAgent');
const { riskProfitAgent }    = require('../agents/riskProfitAgent');
const { reasoningAgent }     = require('../agents/reasoningAgent');
const { writeValidateAgent } = require('../agents/writeValidateAgent');

// ── License middleware ────────────────────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });

  const { data: user } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end, name, business_name, signature_name, reply_tone')
    .eq('license_key', key)
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid license key' });

  if (user.plan === 'owner') { req.user = user; return next(); }

  const now = new Date();
  if (user.plan === 'trial' && now > new Date(user.trial_end))
    return res.status(403).json({ error: 'trial_expired', message: 'Your 14-day trial has ended. Please upgrade to continue.' });
  if (user.plan === 'expired')
    return res.status(403).json({ error: 'trial_expired', message: 'Your trial has ended. Please upgrade to continue.' });
  if (user.plan !== 'trial' && user.subscription_status === 'canceled') {
    if (user.subscription_end && now > new Date(user.subscription_end))
      return res.status(403).json({ error: 'subscription_ended', message: 'Your subscription has ended.' });
  }

  req.user = user;
  next();
}

// ── Junior Agent templates (personalised per seller) ─────────────────────
function runJuniorAgent(user, intent, msg) {
  const sign = user.signature_name || user.name || 'The Seller';
  const lower = (msg || '').toLowerCase().trim();

  const templates = {
    positive_feedback: () => {
      if (/arrived|received|got it/i.test(lower))
        return `Glad to hear it arrived safely — enjoy it!\n\nBest regards,\n${sign}`;
      if (/fast|quick|speedy|prompt/i.test(lower))
        return `Really appreciate that — glad it reached you quickly!\n\nBest regards,\n${sign}`;
      if (/as described|exactly right|perfect|exactly what/i.test(lower))
        return `That's great to hear, thank you! Really glad it's exactly what you were looking for.\n\nBest regards,\n${sign}`;
      if (/great|brilliant|excellent|amazing|wonderful|fantastic/i.test(lower))
        return `Thank you so much — that really means a lot!\n\nBest regards,\n${sign}`;
      if (/thank|thanks/i.test(lower))
        return `You're welcome! Don't hesitate to reach out if you need anything.\n\nBest regards,\n${sign}`;
      return `You're welcome! Really glad everything worked out well.\n\nBest regards,\n${sign}`;
    },
    off_platform: () =>
      `Hi,\n\nThank you for your message. For the protection of both of us, I keep all communication and transactions through eBay's official system.\n\nHappy to help with anything you need right here.\n\nBest regards,\n${sign}`,

    shipping_inquiry: () =>
      `Hi,\n\nThanks for your message! Full shipping details and estimated delivery times are listed on each item's page. If you have a specific question about delivery to your location, just ask and I'll help.\n\nBest regards,\n${sign}`,

    item_question: () =>
      `Hi,\n\nGreat question! All product details, specifications, and compatibility information are listed in the item description — well worth checking there first as it covers most queries.\n\nIf you can't find what you need, just let me know and I'll be happy to help.\n\nBest regards,\n${sign}`,

    dispatch_confirmation: () =>
      `Hi,\n\nThank you for your message! Your order will be dispatched within our stated handling time and you'll receive a tracking notification from eBay as soon as it's on its way.\n\nBest regards,\n${sign}`,

    combined_shipping: () =>
      `Hi,\n\nAbsolutely — happy to combine postage on multiple items. Just add everything to your basket and send a message requesting a revised total before paying. I'll sort the combined invoice for you.\n\nBest regards,\n${sign}`,

    payment_confirmation: () =>
      `Hi,\n\nThank you — payment received! Your order is now being processed and I'll get it dispatched as soon as possible. You'll get a tracking notification from eBay once it's on its way.\n\nBest regards,\n${sign}`,

    availability: () =>
      `Hi,\n\nThanks for your interest! Everything currently available is listed on eBay. If you're looking for something specific that isn't showing, feel free to ask and I'll see what I can do.\n\nBest regards,\n${sign}`,
  };

  if (!templates[intent]) return null;
  return {
    reply:  templates[intent](),
    model:  'rule',
    route:  'rule',
    tokens: 0,
    cost:   0
  };
}

// ── Junior Agent smart gating (Option B) ─────────────────────────────────
// Only fires AFTER Agent 0 — uses real conversation state for safer gating.
function shouldRunJuniorAgent(intent, conversationState, classification, msg) {
  // Hard stops — never fire Junior Agent if any of these are true
  if (conversationState.messageCount > 4)
    return { fire: false, reason: 'conversation has more than 4 messages — too much context for templates' };
  if (conversationState.toneTrajectory === 'escalating')
    return { fire: false, reason: 'conversation tone is escalating' };
  if (conversationState.existingEbayCase)
    return { fire: false, reason: 'existing eBay case open — needs full pipeline' };
  if (conversationState.sellerPreviousPromises.length > 0)
    return { fire: false, reason: 'seller has made previous promises — context needed' };
  if (classification.riskScore > 3)
    return { fire: false, reason: `risk score ${classification.riskScore}/10 too high for template` };
  if (classification.manipulationFlag)
    return { fire: false, reason: 'manipulation detected — needs strategic reply' };
  if (['frustrated', 'angry', 'threatening'].includes(classification.buyerTone))
    return { fire: false, reason: `buyer tone is ${classification.buyerTone}` };
  if (classification.implicitSignals.length > 1)
    return { fire: false, reason: 'multiple implicit signals require considered response' };

  // Conflict word detection — things that look simple but aren't
  const complexitySignals = /\b(already|still|yet|weeks?|days?|supposed to|should have|tried|before|again|chased|contacted|previous|last time|still waiting|still haven't)\b/i;
  if (complexitySignals.test(msg))
    return { fire: false, reason: 'message contains complexity signals despite simple intent' };

  // AI classifier must agree
  if (!classification.shouldUseJuniorAgent)
    return { fire: false, reason: classification.juniorAgentReason };

  // Always-template intents
  if (['positive_feedback', 'off_platform'].includes(intent))
    return { fire: true, reason: `${intent} — always handled by template` };

  // Short-message-only intents
  const shortIntents = ['shipping_inquiry', 'item_question', 'dispatch_confirmation', 'combined_shipping', 'payment_confirmation', 'availability'];
  if (shortIntents.includes(intent) && msg.trim().length < 110)
    return { fire: true, reason: `${intent} — short, simple, no complexity signals` };

  return { fire: false, reason: 'did not meet all Junior Agent criteria' };
}

// ── Build Why Data from new v5 agent outputs ──────────────────────────────
function buildWhyData({ classification, conversationState, risk, profitProtection, reasoning, dataFetch, latency, route }) {
  const agentMap = {
    rule:  { name: 'Junior Agent',    icon: '📋' },
    mini:  { name: 'Senior Agent',    icon: '✍️'  },
    large: { name: 'Risk Specialist', icon: '🛡️' }
  };
  const agent = agentMap[route] || agentMap.mini;

  const dt = dataFetch?.trace || {};

  // eBay data status line
  let ebayStatus = null;
  const orderIntents = ['tracking', 'return', 'refund', 'damaged_item', 'cancellation'];
  if (dt.tracking_found && dt.tracking_number) {
    ebayStatus = { type: 'good', text: `Live tracking checked: ${dt.tracking_carrier ? dt.tracking_carrier + ' · ' : ''}${dt.tracking_number}` };
  } else if (dt.order_found) {
    ebayStatus = { type: 'good', text: 'Live eBay order data used' };
  } else if (dt.ebay_connected && orderIntents.includes(classification.primaryIntent)) {
    ebayStatus = { type: 'warn', text: 'eBay connected but no order ID found in this conversation' };
  } else if (!dt.ebay_connected && orderIntents.includes(classification.primaryIntent)) {
    ebayStatus = { type: 'missing', text: 'eBay not connected — reply written without live order data', showConnect: true };
  }

  const riskLabels = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' };

  return {
    agent,
    paragraph: reasoning.strategyBrief || 'Reply generated from buyer message and available data.',
    structured: {
      risk:               { level: risk.finalLevel, label: riskLabels[risk.finalLevel] || 'Low Risk', score: risk.finalScore },
      constraints:        (reasoning.constraints || []).slice(0, 4),
      ebayStatus,
      latency_ms:         latency,
      sendConfidence:     null,   // filled from writeValidateAgent after this is called
      humanReview:        risk.humanReviewRequired || false,
      allIntents:         classification.allIntents || [],
      buyerTone:          classification.buyerTone  || 'neutral',
      conflictResolutions: reasoning.conflictResolutions || [],
      bestResolution:     (profitProtection.resolutionOptions || []).find(r => r.recommended) || null
    }
  };
}

// ── Strip preamble from AI text ───────────────────────────────────────────
function stripPreamble(text) {
  if (!text) return text;
  const patterns = [
    /^(here'?s?|sure[,!]?|of course[,!]?|certainly[,!]?|absolutely[,!]?).{0,80}:\s*/i,
    /^(i'?ve?|i have).{0,60}:\s*/i,
    /^(below is|here is|the (updated|revised|new) (reply|message|version)).{0,60}:\s*/i,
    /^(updated|revised|modified) (reply|message|version)[:\s]+/i,
  ];
  for (const pat of patterns) {
    const cleaned = text.replace(pat, '').trim();
    if (cleaned.length > 20 && cleaned !== text) return cleaned;
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines[0].trim().endsWith(':') && lines[0].trim().length < 100) {
    const rest = lines.slice(1).join('\n').trim();
    if (rest.length > 20) return rest;
  }
  return text;
}

// ── POST /reply/generate ──────────────────────────────────────────────────
router.post('/generate', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      customer_message,
      latest_buyer_message,
      thread_messages,
      modify_instructions,
      order_id,
      product_title,
      product_description,
      is_pre_purchase
    } = req.body;

    const threadMessages = Array.isArray(thread_messages) ? thread_messages : [];

    // ── FIX: Always reply to last BUYER message, never the seller's own ──────
    // The extension passes latest_buyer_message but sometimes the last message
    // in the thread is from the seller. Detect and correct this silently.
    let latestBuyerMessage = (latest_buyer_message || customer_message || '').trim();

    if (threadMessages.length > 0) {
      const lastMsg  = threadMessages[threadMessages.length - 1];
      const lastRole = (lastMsg?.role || '').toLowerCase();
      // If extension passed the seller's own last message, find real buyer message
      if (lastRole === 'seller' && latestBuyerMessage === (lastMsg?.text || '').trim()) {
        const lastBuyer = [...threadMessages].reverse()
          .find(m => (m.role || '').toLowerCase() === 'buyer' && (m.text || '').trim().length > 2);
        if (lastBuyer) latestBuyerMessage = lastBuyer.text.trim();
      }
    }
    // Final fallback — scan for any buyer message in thread
    if (!latestBuyerMessage || latestBuyerMessage.length < 3) {
      const lastBuyer = [...threadMessages].reverse()
        .find(m => (m.role || '').toLowerCase() === 'buyer' && (m.text || '').trim().length > 2);
      if (lastBuyer) latestBuyerMessage = lastBuyer.text.trim();
    }

    if (!latestBuyerMessage || latestBuyerMessage.length < 3)
      return res.status(400).json({ error: 'No buyer message found to reply to.' });

    const user = req.user;

    // ── Shared pipeline context object ────────────────────────────────────
    const ctx = {
      latestBuyerMessage,
      threadMessages,
      productTitle:       product_title       || '',
      productDescription: product_description || '',
      orderId:            order_id             || null,
      user,
      totalTokens:        0,
      totalCost:          0
    };

    // ════════════════════════════════════════════════════════════════════
    // CALL 1 — Agent 0 (Pre-Process) + Agent 1 (Classify) — GPT-4o
    // ════════════════════════════════════════════════════════════════════
    const preClassify = await preClassifyAgent({
      latestBuyerMessage: ctx.latestBuyerMessage,
      threadMessages:     ctx.threadMessages
    });

    ctx.totalTokens += preClassify.tokens || 0;
    ctx.totalCost   += preClassify.cost   || 0;

    const conversationState = preClassify.conversationState;
    const classification    = preClassify.classification;
    ctx.orderId = order_id || classification.entities?.orderId || null;

    // ════════════════════════════════════════════════════════════════════
    // OPTION B: Junior Agent check — runs after Agent 0, before full pipeline
    // ════════════════════════════════════════════════════════════════════
    const intent  = classification.primaryIntent;
    const jGating = shouldRunJuniorAgent(intent, conversationState, classification, ctx.latestBuyerMessage);

    if (jGating.fire) {
      const juniorResult = runJuniorAgent(user, intent, ctx.latestBuyerMessage);
      if (juniorResult) {
        const latency = Date.now() - startTime;
        trackUsage(user.id, 'rule', preClassify.tokens || 0, preClassify.cost || 0).catch(() => {});
        logReply(user.id, intent, 'rule', 'rule', ctx.latestBuyerMessage, juniorResult.reply, latency, preClassify.tokens || 0, preClassify.cost || 0).catch(() => {});
        supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});
        return res.json({
          success:    true,
          reply:      juniorResult.reply,
          intent,
          risk:       'low',
          route:      'rule',
          latency_ms: latency,
          why: {
            agent:     { name: 'Junior Agent', icon: '📋' },
            paragraph: `${intent.replace(/_/g, ' ')} — handled instantly with a personalised template. ${jGating.reason}.`,
            structured: {
              risk:               { level: 'low', label: 'Low Risk', score: 1 },
              constraints:        [],
              ebayStatus:         null,
              latency_ms:         latency,
              sendConfidence:     95,
              humanReview:        false,
              allIntents:         classification.allIntents,
              buyerTone:          classification.buyerTone,
              conflictResolutions: []
            }
          }
        });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PARALLEL BLOCK — Data Fetch + Risk/Profit + Seller Prefs simultaneously
    // All three only need Call 1 output. Saves 4-8 seconds per reply.
    // ════════════════════════════════════════════════════════════════════
    const needsOrder = ['tracking', 'return', 'refund', 'cancellation', 'damaged_item'].includes(intent);

    const [dataFetch, riskProfit, prefRows] = await Promise.all([
      // Agent 2 — eBay Data Fetch (no AI)
      dataFetchAgent({ userId: user.id, needs: { order: needsOrder }, orderId: ctx.orderId }),
      // Call 2 — Risk + Profit Protection (GPT-4o-mini)
      riskProfitAgent({
        classification,
        conversationState,
        dataFetch: { fetched: {}, trace: {}, missing: [] },
        productTitle: ctx.productTitle,
        orderValue:   null
      }),
      // Seller preferences (Supabase)
      supabase
        .from('seller_preferences')
        .select('insight, applies_to_intent, times_seen')
        .eq('user_id', user.id)
        .or(`applies_to_intent.eq.${intent},applies_to_intent.is.null`)
        .order('times_seen', { ascending: false })
        .limit(6)
        .then(r => r.data || [])
        .catch(() => [])
    ]);

    ctx.totalTokens += riskProfit.tokens || 0;
    ctx.totalCost   += riskProfit.cost   || 0;

    const risk             = riskProfit.risk;
    const profitProtection = riskProfit.profitProtection;

    // Inject learned seller preferences
    if (prefRows.length > 0)
      risk.constraints = [...(risk.constraints || []), ...prefRows.map(p => p.insight)];

    // ── Pre-purchase hard constraints ─────────────────────────────────────
    // If there is no order ID on the page, this is a potential buyer enquiry.
    // The writer must NEVER reference orders, tracking, or ask for feedback.
    if (is_pre_purchase) {
      risk.constraints = [
        'This is a PRE-PURCHASE enquiry — the buyer has NOT ordered yet',
        'NEVER mention orders, tracking numbers, or delivery status',
        'NEVER ask for feedback or reviews — no order has been placed',
        'NEVER say "your order" — there is no order',
        'Treat this as a potential customer who may be deciding whether to buy',
        'Be helpful, answer their question, and make them feel confident about purchasing',
        ...(risk.constraints || [])
      ];
    }

    // ════════════════════════════════════════════════════════════════════
    // CALL 3 — Agent 5 (Reasoning / Strategy Brief) — GPT-4o
    // Runs after parallel block — has full data from all previous agents
    // ════════════════════════════════════════════════════════════════════
    const reasoning = await reasoningAgent({
      classification,
      conversationState,
      dataFetch,
      risk,
      profitProtection,
      productTitle:       ctx.productTitle,
      productDescription: ctx.productDescription,
      user,
      latestBuyerMessage: ctx.latestBuyerMessage
    });

    ctx.totalTokens += reasoning.tokens || 0;
    ctx.totalCost   += reasoning.cost   || 0;

    // ════════════════════════════════════════════════════════════════════
    // CALL 4 — Agent 6 (Writer) + Agent 7 (Validator) — GPT-4o
    // ════════════════════════════════════════════════════════════════════
    let writeResult;
    try {
      writeResult = await writeValidateAgent({
        user,
        latestBuyerMessage: ctx.latestBuyerMessage,
        threadMessages:     ctx.threadMessages,
        reasoning,
        classification,
        risk,
        dataFetch
      });
    } catch (err) {
      console.error('[reply] writeValidateAgent failed:', err.message);
      return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
    }

    ctx.totalTokens += writeResult.tokens || 0;
    ctx.totalCost   += writeResult.cost   || 0;

    const finalReply = stripPreamble(writeResult.reply);
    const route      = risk.finalScore >= 7 ? 'large' : 'mini';
    const latency    = Date.now() - startTime;

    // ── Build Why payload ─────────────────────────────────────────────────
    const why = buildWhyData({
      classification,
      conversationState,
      risk,
      profitProtection,
      reasoning,
      dataFetch,
      latency,
      route
    });

    // Attach validator output to Why panel
    if (writeResult.validation) {
      why.structured.sendConfidence  = writeResult.validation.sendConfidence;
      why.structured.humanReview     = writeResult.validation.humanReviewRequired || risk.humanReviewRequired;
      why.structured.validationFlags = writeResult.validation.flags || [];
      why.structured.wasRetried      = writeResult.wasRetried || false;
    }

    // ── Usage tracking + logging (fire and forget) ────────────────────────
    trackUsage(user.id, route, ctx.totalTokens, ctx.totalCost).catch(e => console.warn('[reply] Usage tracking failed:', e.message));
    logReply(user.id, intent, route, 'gpt-4o', ctx.latestBuyerMessage, finalReply, latency, ctx.totalTokens, ctx.totalCost).catch(e => console.warn('[reply] Log failed:', e.message));
    supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});

    const debug = req.query.debug === '1';

    res.json({
      success:    true,
      reply:      finalReply,
      intent,
      risk:       risk.finalLevel,
      route,
      latency_ms: latency,
      why,
      ...(writeResult.validation ? { validation: writeResult.validation } : {}),
      ...(debug ? {
        agents: {
          conversationState,
          classification,
          dataFetch:       { trace: dataFetch.trace, missing: dataFetch.missing },
          risk,
          profitProtection,
          reasoning:       { strategyBrief: reasoning.strategyBrief, priorityList: reasoning.priorityList, conflictResolutions: reasoning.conflictResolutions },
          writeValidation: writeResult.validation,
          totalTokens:     ctx.totalTokens,
          totalCost:       ctx.totalCost
        }
      } : {})
    });

  } catch (err) {
    console.error('[reply] Generation error:', err);
    res.status(500).json({ error: 'Failed to generate reply. Please try again.' });
  }
});

// ── Usage tracking helper ─────────────────────────────────────────────────
async function trackUsage(userId, route, tokens, cost) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('usage')
    .select('id, replies_count, rule_count, mini_count, large_count, tokens_used, cost_usd')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  if (existing) {
    await supabase.from('usage').update({
      replies_count: existing.replies_count + 1,
      rule_count:    existing.rule_count  + (route === 'rule'  ? 1 : 0),
      mini_count:    existing.mini_count  + (route === 'mini'  ? 1 : 0),
      large_count:   existing.large_count + (route === 'large' ? 1 : 0),
      tokens_used:   existing.tokens_used + (tokens || 0),
      cost_usd:      parseFloat(existing.cost_usd) + (cost || 0)
    }).eq('id', existing.id);
  } else {
    await supabase.from('usage').insert({
      user_id:       userId,
      date:          today,
      replies_count: 1,
      rule_count:    route === 'rule'  ? 1 : 0,
      mini_count:    route === 'mini'  ? 1 : 0,
      large_count:   route === 'large' ? 1 : 0,
      tokens_used:   tokens || 0,
      cost_usd:      cost   || 0
    });
  }
}

// ── Reply log helper ──────────────────────────────────────────────────────
async function logReply(userId, intent, route, model, message, reply, latency, tokens, cost) {
  await supabase.from('reply_log').insert({
    user_id:          userId,
    intent,
    route,
    model,
    customer_message: message.slice(0, 2000),
    generated_reply:  reply.slice(0, 2000),
    latency_ms:       latency,
    tokens_used:      tokens || 0,
    cost_usd:         cost   || 0,
    source:           'extension'
  });
}

// ── Strips conversational preamble from AI replies ────────────────────────
function stripPreamble(text) {
  if (!text) return text;
  const patterns = [
    /^(here'?s?|sure[,!]?|of course[,!]?|certainly[,!]?|absolutely[,!]?).{0,80}:\s*/i,
    /^(i'?ve?|i have).{0,60}:\s*/i,
    /^(below is|here is|the (updated|revised|new) (reply|message|version)).{0,60}:\s*/i,
    /^(updated|revised|modified) (reply|message|version)[:\s]+/i,
  ];
  for (const pat of patterns) {
    const cleaned = text.replace(pat, '').trim();
    if (cleaned.length > 20 && cleaned !== text) return cleaned;
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines[0].trim().endsWith(':') && lines[0].trim().length < 100) {
    const rest = lines.slice(1).join('\n').trim();
    if (rest.length > 20) return rest;
  }
  return text;
}

// ── POST /reply/modify ────────────────────────────────────────────────────
router.post('/modify', requireLicense, async (req, res) => {
  const startTime = Date.now();
  try {
    const { customer_message, conversation_history, instructions, thread_messages } = req.body;

    if (!instructions || instructions.trim().length < 1)
      return res.status(400).json({ error: 'Instructions are required' });
    if (!conversation_history || !Array.isArray(conversation_history) || conversation_history.length < 2)
      return res.status(400).json({ error: 'Conversation history required' });

    const user = req.user;
    const sign = user.signature_name || user.name || 'The Seller';
    const biz  = user.business_name  || 'the store';
    const tone = user.reply_tone     || 'professional';

    const systemPrompt = `You are the dedicated reply assistant for ${biz}, an eBay seller. You write customer service replies on behalf of ${sign}.

SELLER CONTEXT:
- Business: ${biz}
- Signing as: ${sign}
- Preferred tone: ${tone}
- Platform: eBay (all communication stays on eBay — never suggest WhatsApp, email, phone, PayPal direct)

YOUR ROLE IN THIS CONVERSATION:
You are being used like ChatGPT. The seller is talking directly to you to refine a reply. You have full memory of every instruction given so far in this session.

CRITICAL RULES:
1. Read the seller's full instruction carefully — even if it is long and detailed. Process every part of it before writing.
2. Follow the instruction EXACTLY and COMPLETELY. If they say "do X and also Y and make sure Z" — do all three.
3. If instruction says "shorter" or "just say X" — be minimal. Don't add extra content they didn't ask for.
4. Never suggest off-eBay communication.
5. Never admit fault or accept liability unless explicitly instructed.
6. Always end with: "Best regards,\\n${sign}"
7. OUTPUT THE REPLY ONLY — no preamble, no "Here's the revised reply:", no explanation before or after.`;

    const messages = [
      ...conversation_history,
      { role: 'user', content: `My instruction: ${instructions.trim()}` }
    ];

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens:  800,
        temperature: 0.5
      })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message || 'OpenAI error');

    const modifiedReply = stripPreamble(aiData.choices[0].message.content.trim());
    const usage   = aiData.usage || {};
    const tokens  = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const cost    = ((usage.prompt_tokens || 0) * 0.00000015) + ((usage.completion_tokens || 0) * 0.0000006);
    const latency = Date.now() - startTime;

    await supabase.from('reply_log').insert({
      user_id:             user.id,
      intent:              'modification',
      route:               'modify',
      model:               'gpt-4o-mini',
      customer_message:    (customer_message || '').slice(0, 2000),
      generated_reply:     modifiedReply.slice(0, 2000),
      modify_instructions: instructions.slice(0, 1000),
      latency_ms:          latency,
      tokens_used:         tokens,
      cost_usd:            parseFloat(cost.toFixed(6)),
      source:              'extension'
    });

    analyseAndSavePreference({
      userId:      user.id,
      instruction: instructions,
      reply:       modifiedReply,
      intent:      req.body.intent || 'general'
    }).catch(err => console.error('Preference analysis failed silently:', err.message));

    res.json({
      success:    true,
      reply:      modifiedReply,
      route:      'modify',
      model:      'gpt-4o-mini',
      latency_ms: latency,
      updated_history: [...messages, { role: 'assistant', content: modifiedReply }]
    });

  } catch (err) {
    console.error('[reply] Modify error:', err);
    res.status(500).json({ error: 'Failed to modify reply. Please try again.' });
  }
});

// ── Async preference analyser (fire-and-forget) ───────────────────────────
async function analyseAndSavePreference({ userId, instruction, reply, intent }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const prompt = `An eBay seller gave this instruction to modify a customer service reply:

INSTRUCTION: "${instruction}"

RESULTING REPLY: "${reply.slice(0, 500)}"

Analyse what this instruction reveals about the seller's preferences or policies. Respond ONLY with a JSON object — no markdown, no explanation:

{
  "category": "tone|length|content|policy|greeting|closing",
  "insight": "one clear sentence describing what this seller always wants or never does",
  "applies_to_intent": "tracking|return|refund|damaged_item|cancellation|positive_feedback|general|null"
}

Rules:
- insight must be a generalised pattern, not specific to this one message
- if the instruction is too vague to extract a meaningful preference, return {"skip": true}
- applies_to_intent should be null if this preference applies to all message types`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 150, temperature: 0.2 })
  });

  const data = await r.json();
  if (data.error) return;

  let parsed;
  try {
    const text = data.choices?.[0]?.message?.content || '';
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch { return; }

  if (!parsed || parsed.skip || !parsed.insight || !parsed.category) return;

  const { data: existing } = await supabase
    .from('seller_preferences')
    .select('id, times_seen')
    .eq('user_id', userId)
    .eq('insight', parsed.insight)
    .single();

  if (existing) {
    await supabase.from('seller_preferences').update({
      times_seen:         existing.times_seen + 1,
      last_seen:          new Date().toISOString(),
      source_instruction: instruction.slice(0, 500)
    }).eq('id', existing.id);
  } else {
    await supabase.from('seller_preferences').insert({
      user_id:            userId,
      category:           parsed.category,
      insight:            parsed.insight,
      applies_to_intent:  parsed.applies_to_intent || null,
      source_instruction: instruction.slice(0, 500),
      times_seen:         1
    });
  }
}

// ── GET /seller/insights ──────────────────────────────────────────────────
router.get('/seller/insights', requireLicense, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_preferences')
      .select('id, category, insight, applies_to_intent, times_seen, last_seen, source_instruction')
      .eq('user_id', req.user.id)
      .order('times_seen', { ascending: false })
      .limit(50);

    if (error) throw error;

    const grouped = {};
    for (const row of (data || [])) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }

    res.json({ success: true, total: (data || []).length, grouped });
  } catch (err) {
    console.error('[reply] Insights error:', err);
    res.status(500).json({ error: 'Failed to load insights' });
  }
});

module.exports = router;
