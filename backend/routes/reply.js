// routes/reply.js — ReplyMate Pro v7.0
// ARCHITECTURE:
//   Option A: /reply/preclassify — fires on conversation open, caches result 30s
//   Option C: preClassify(mini) + dataFetch run in PARALLEL
//             riskProfit(mini) + reasoning(mini) run in PARALLEL after that
//             writeValidateAgent(4o) streams immediately after
//
// TIMING TARGET:
//   Cache hit:  dataFetch parallel ~0.8s → riskProfit+reason parallel ~2s → stream first word ~2-3s ✅
//   Cache miss: preClassify(mini)+dataFetch parallel ~0.8s → same → stream first word ~3-4s ✅

const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../db/supabase');

const { preClassifyAgent }   = require('../agents/preClassifyAgent');
const { dataFetchAgent }     = require('../agents/dataFetchAgent');
const { riskProfitAgent }    = require('../agents/riskProfitAgent');
const { reasoningAgent }     = require('../agents/reasoningAgent');
const { writeValidateAgent } = require('../agents/writeValidateAgent');

// ── Option A: In-memory preclassify cache ─────────────────────────────────
// Key: licenseKey + md5-ish of buyer message. TTL: 30s.
const preClassifyCache = new Map();
const CACHE_TTL_MS = 30000;

function getCacheKey(licenseKey, buyerMessage) {
  // Simple key — first 120 chars of message is enough to identify it
  return `${licenseKey}::${buyerMessage.trim().slice(0, 120)}`;
}

function cacheSet(key, value) {
  preClassifyCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  // Clean up old entries (keep map small)
  if (preClassifyCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of preClassifyCache) {
      if (v.expires < now) preClassifyCache.delete(k);
    }
  }
}

function cacheGet(key) {
  const entry = preClassifyCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { preClassifyCache.delete(key); return null; }
  return entry.value;
}

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

// ── Strip AI preamble ─────────────────────────────────────────────────────
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

// ── Junior Agent templates ────────────────────────────────────────────────
function runJuniorAgent(user, intent, msg) {
  const sign  = user.signature_name || user.name || 'The Seller';
  const lower = (msg || '').toLowerCase().trim();

  const templates = {
    positive_feedback: () => {
      if (/arrived|received|got it/i.test(lower))      return `Glad to hear it arrived safely — enjoy it!\n\nBest regards,\n${sign}`;
      if (/fast|quick|speedy|prompt/i.test(lower))     return `Really appreciate that — glad it reached you quickly!\n\nBest regards,\n${sign}`;
      if (/as described|exactly right|perfect/i.test(lower)) return `That's great to hear, thank you! Really glad it's exactly what you were looking for.\n\nBest regards,\n${sign}`;
      if (/great|brilliant|excellent|amazing/i.test(lower))  return `Thank you so much — that really means a lot!\n\nBest regards,\n${sign}`;
      if (/thank|thanks/i.test(lower))                 return `You're welcome! Don't hesitate to reach out if you need anything.\n\nBest regards,\n${sign}`;
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
  return { reply: templates[intent](), model: 'rule', route: 'rule', tokens: 0, cost: 0 };
}

// ── Junior Agent smart gating ─────────────────────────────────────────────
function shouldRunJuniorAgent(intent, conversationState, classification, msg) {
  if (conversationState.messageCount > 4)           return { fire: false, reason: 'conversation has >4 messages' };
  if (conversationState.toneTrajectory === 'escalating') return { fire: false, reason: 'tone escalating' };
  if (conversationState.existingEbayCase)           return { fire: false, reason: 'existing eBay case' };
  if (conversationState.sellerPreviousPromises.length > 0) return { fire: false, reason: 'seller made previous promises' };
  if (classification.riskScore > 3)                 return { fire: false, reason: `risk score ${classification.riskScore}/10 too high` };
  if (classification.manipulationFlag)              return { fire: false, reason: 'manipulation detected' };
  if (['frustrated','angry','threatening'].includes(classification.buyerTone))
                                                    return { fire: false, reason: `buyer tone: ${classification.buyerTone}` };
  if (classification.implicitSignals.length > 1)    return { fire: false, reason: 'multiple implicit signals' };

  const complexitySignals = /\b(already|still|yet|weeks?|days?|supposed to|should have|tried|before|again|chased|contacted|previous|last time|still waiting|still haven't)\b/i;
  if (complexitySignals.test(msg))                  return { fire: false, reason: 'complexity signals in message' };
  if (!classification.shouldUseJuniorAgent)         return { fire: false, reason: classification.juniorAgentReason };

  if (['positive_feedback','off_platform'].includes(intent))
    return { fire: true, reason: `${intent} — always template` };

  const shortIntents = ['shipping_inquiry','item_question','dispatch_confirmation','combined_shipping','payment_confirmation','availability'];
  if (shortIntents.includes(intent) && msg.trim().length < 110)
    return { fire: true, reason: `${intent} — short, simple` };

  return { fire: false, reason: 'did not meet all criteria' };
}

// ── Build Why data from full pipeline output ──────────────────────────────
function buildWhyData({ classification, conversationState, risk, profitProtection, reasoning, dataFetch, latency, route }) {
  const agentMap = {
    rule:  { name: 'Junior Agent',    icon: '📋' },
    mini:  { name: 'Senior Agent',    icon: '✍️'  },
    large: { name: 'Risk Specialist', icon: '🛡️' }
  };
  const agent = agentMap[route] || agentMap.mini;
  const dt    = dataFetch?.trace || {};

  let ebayStatus = null;
  const orderIntents = ['tracking','return','refund','damaged_item','cancellation'];
  if (dt.tracking_found && dt.tracking_number) {
    ebayStatus = { type: 'good', text: `Live tracking: ${dt.tracking_carrier ? dt.tracking_carrier + ' · ' : ''}${dt.tracking_number}` };
  } else if (dt.order_found) {
    ebayStatus = { type: 'good', text: 'Live eBay order data used' };
  } else if (dt.ebay_connected && orderIntents.includes(classification.primaryIntent)) {
    ebayStatus = { type: 'warn', text: 'eBay connected but no order ID found' };
  } else if (!dt.ebay_connected && orderIntents.includes(classification.primaryIntent)) {
    ebayStatus = { type: 'missing', text: 'eBay not connected — reply written without live order data', showConnect: true };
  }

  const riskLabels = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' };
  return {
    agent,
    paragraph: reasoning.strategyBrief || 'Reply generated from buyer message and available data.',
    structured: {
      risk:                { level: risk.finalLevel, label: riskLabels[risk.finalLevel] || 'Low Risk', score: risk.finalScore },
      constraints:         (reasoning.constraints || []).slice(0, 4),
      ebayStatus,
      latency_ms:          latency,
      sendConfidence:      null,
      humanReview:         risk.humanReviewRequired || false,
      allIntents:          classification.allIntents || [],
      buyerTone:           classification.buyerTone  || 'neutral',
      conflictResolutions: reasoning.conflictResolutions || [],
      bestResolution:      (profitProtection.resolutionOptions || []).find(r => r.recommended) || null
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// OPTION A — POST /reply/preclassify
// Extension fires this on conversation load (before Generate is clicked).
// Result cached 30s — if Generate clicked in time, the classify step is free.
// Lightweight: no Supabase write, no usage tracking, just classify + cache.
// ════════════════════════════════════════════════════════════════════════════
router.post('/preclassify', requireLicense, async (req, res) => {
  try {
    const { latest_buyer_message, thread_messages } = req.body;
    const buyerMsg       = (latest_buyer_message || '').trim();
    const threadMessages = Array.isArray(thread_messages) ? thread_messages : [];

    if (!buyerMsg || buyerMsg.length < 3)
      return res.status(400).json({ error: 'buyer message required' });

    const licenseKey = req.headers['x-license-key'];
    const cacheKey   = getCacheKey(licenseKey, buyerMsg);

    // Already cached — return immediately
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ success: true, cached: true, ...cached });

    // Run classify — mini model so ~0.8s
    const result = await preClassifyAgent({ latestBuyerMessage: buyerMsg, threadMessages });

    // Cache the result
    cacheSet(cacheKey, result);

    res.json({ success: true, cached: false, ...result });
  } catch (err) {
    // Non-fatal — Generate will just run classify itself
    console.error('[reply] Preclassify error (non-fatal):', err.message);
    res.status(500).json({ error: 'preclassify failed' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /reply/generate — Full pipeline v7.0
// Option C: parallel stages, mini models for classify+reason, 4o for writer
// Option A: cache hit skips classify entirely
// ════════════════════════════════════════════════════════════════════════════
router.post('/generate', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      customer_message,
      latest_buyer_message,
      thread_messages,
      order_id,
      product_title,
      product_description,
      is_pre_purchase
    } = req.body;

    const latestBuyerMessage = (latest_buyer_message || customer_message || '').trim();
    const threadMessages     = Array.isArray(thread_messages) ? thread_messages : [];

    if (!latestBuyerMessage || latestBuyerMessage.length < 3)
      return res.status(400).json({ error: 'Customer message is required' });

    const user       = req.user;
    const licenseKey = req.headers['x-license-key'];

    // ── STAGE 1: preClassify + dataFetch in PARALLEL ──────────────────────
    // Check cache first (Option A) — if hit, dataFetch runs solo (~0.4s)
    // If cache miss, both run in parallel (~0.8s each, net = ~0.8s)
    const cacheKey    = getCacheKey(licenseKey, latestBuyerMessage);
    const cachedClassify = cacheGet(cacheKey);

    let preClassify, dataFetch;

    const needsOrder = ['tracking','return','refund','cancellation','damaged_item'];

    if (cachedClassify) {
      // Cache hit — dataFetch is the only thing we wait for
      preClassify = cachedClassify;
      dataFetch   = await dataFetchAgent({
        userId:  user.id,
        needs:   { order: needsOrder.includes(cachedClassify.classification?.primaryIntent) },
        orderId: order_id || cachedClassify.classification?.entities?.orderId || null
      });
    } else {
      // Cache miss — run both in parallel
      const stage1 = await Promise.all([
        preClassifyAgent({ latestBuyerMessage, threadMessages }),
        dataFetchAgent({
          userId:  user.id,
          needs:   { order: true }, // fetch optimistically — we don't know intent yet
          orderId: order_id || null
        })
      ]);
      preClassify = stage1[0];
      dataFetch   = stage1[1];
      // Cache for potential retry
      cacheSet(cacheKey, preClassify);
    }

    const conversationState = preClassify.conversationState;
    const classification    = preClassify.classification;
    const intent            = classification.primaryIntent;
    const orderId           = order_id || classification.entities?.orderId || null;

    let totalTokens = preClassify.tokens || 0;
    let totalCost   = preClassify.cost   || 0;

    // ── Junior Agent gate (fast path — no more AI calls) ─────────────────
    const jGating = shouldRunJuniorAgent(intent, conversationState, classification, latestBuyerMessage);
    if (jGating.fire) {
      const juniorResult = runJuniorAgent(user, intent, latestBuyerMessage);
      if (juniorResult) {
        const latency = Date.now() - startTime;
        trackUsage(user.id, 'rule', totalTokens, totalCost).catch(() => {});
        logReply(user.id, intent, 'rule', 'rule', latestBuyerMessage, juniorResult.reply, latency, totalTokens, totalCost).catch(() => {});
        supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});
        return res.json({
          success: true, reply: juniorResult.reply, intent, risk: 'low', route: 'rule', latency_ms: latency,
          why: {
            agent: { name: 'Junior Agent', icon: '📋' },
            paragraph: `${intent.replace(/_/g, ' ')} — handled instantly with a personalised template.`,
            structured: {
              risk: { level: 'low', label: 'Low Risk', score: 1 },
              constraints: [], ebayStatus: null, latency_ms: latency, sendConfidence: 95,
              humanReview: false, allIntents: classification.allIntents, buyerTone: classification.buyerTone, conflictResolutions: []
            }
          }
        });
      }
    }

    // ── STAGE 2: riskProfit + reasoningAgent in PARALLEL ─────────────────
    // Both need: classification, conversationState, dataFetch
    // Both use gpt-4o-mini — run together, net time = ~1.5-2s
    const [riskProfit, prefRows] = await Promise.all([
      riskProfitAgent({ classification, conversationState, dataFetch, productTitle: product_title || '', orderValue: null }),
      supabase.from('seller_preferences')
        .select('insight, applies_to_intent, times_seen')
        .eq('user_id', user.id)
        .or(`applies_to_intent.eq.${intent},applies_to_intent.is.null`)
        .order('times_seen', { ascending: false })
        .limit(6)
        .then(r => r.data || [])
        .catch(() => [])
    ]);

    totalTokens += riskProfit.tokens || 0;
    totalCost   += riskProfit.cost   || 0;

    const risk             = riskProfit.risk;
    const profitProtection = riskProfit.profitProtection;

    // Inject seller prefs into risk constraints
    if (prefRows.length > 0) {
      risk.constraints = [...(risk.constraints || []), ...prefRows.map(p => p.insight)];
    }

    // Inject pre-purchase constraints if needed
    if (is_pre_purchase) {
      risk.constraints = [...(risk.constraints || []),
        'This is a pre-purchase enquiry — buyer has NOT ordered yet',
        'Never mention order IDs, tracking, or fulfilment timelines',
        'Never reference feedback or post-sale processes',
        'Treat buyer as a potential customer, not an existing one'
      ];
    }

    // Now run reasoningAgent (needs riskProfit output)
    const reasoning = await reasoningAgent({
      classification, conversationState, dataFetch, risk, profitProtection,
      productTitle:       product_title       || '',
      productDescription: product_description || '',
      user,
      latestBuyerMessage
    });

    totalTokens += reasoning.tokens || 0;
    totalCost   += reasoning.cost   || 0;

    // ── STAGE 3: writeValidateAgent — GPT-4o streaming ───────────────────
    // SSE headers — first word appears in ~1-2s
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (obj) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // Stage status — extension shows real progress
    sendEvent({ type: 'status', stage: 'writing' });

    let writeResult;
    try {
      writeResult = await writeValidateAgent({
        user,
        latestBuyerMessage,
        threadMessages,
        reasoning,
        classification,
        risk,
        dataFetch,
        onChunk: (chunk) => sendEvent({ type: 'chunk', text: chunk })
      });
    } catch (err) {
      console.error('[reply] writeValidateAgent failed:', err.message);
      sendEvent({ type: 'error', message: 'AI service unavailable. Please try again.' });
      res.end();
      return;
    }

    totalTokens += writeResult.tokens || 0;
    totalCost   += writeResult.cost   || 0;

    const finalReply = stripPreamble(writeResult.reply);
    const route      = risk.finalScore >= 7 ? 'large' : 'mini';
    const latency    = Date.now() - startTime;

    const why = buildWhyData({ classification, conversationState, risk, profitProtection, reasoning, dataFetch, latency, route });
    if (writeResult.validation) {
      why.structured.sendConfidence  = writeResult.validation.sendConfidence;
      why.structured.humanReview     = writeResult.validation.humanReviewRequired || risk.humanReviewRequired;
      why.structured.validationFlags = writeResult.validation.flags || [];
    }

    // Done event — extension seeds modifyHistory and inserts into eBay
    sendEvent({
      type:       'done',
      reply:      finalReply,
      intent,
      risk:       risk.finalLevel,
      route,
      latency_ms: latency,
      why
    });

    res.end();

    // Fire-and-forget tracking
    trackUsage(user.id, route, totalTokens, totalCost).catch(() => {});
    logReply(user.id, intent, route, 'gpt-4o', latestBuyerMessage, finalReply, latency, totalTokens, totalCost).catch(() => {});
    supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});

  } catch (err) {
    console.error('[reply] Generation error:', err);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to generate reply. Please try again.' })}\n\n`);
      res.end();
    } catch {}
  }
});

// ── Usage tracking ────────────────────────────────────────────────────────
async function trackUsage(userId, route, tokens, cost) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase.from('usage')
    .select('id, replies_count, rule_count, mini_count, large_count, tokens_used, cost_usd')
    .eq('user_id', userId).eq('date', today).single();

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
      user_id: userId, date: today, replies_count: 1,
      rule_count:  route === 'rule'  ? 1 : 0,
      mini_count:  route === 'mini'  ? 1 : 0,
      large_count: route === 'large' ? 1 : 0,
      tokens_used: tokens || 0, cost_usd: cost || 0
    });
  }
}

async function logReply(userId, intent, route, model, message, reply, latency, tokens, cost) {
  await supabase.from('reply_log').insert({
    user_id: userId, intent, route, model,
    customer_message: message.slice(0, 2000),
    generated_reply:  reply.slice(0, 2000),
    latency_ms: latency, tokens_used: tokens || 0, cost_usd: cost || 0, source: 'extension'
  });
}

// ── POST /reply/modify ────────────────────────────────────────────────────
router.post('/modify', requireLicense, async (req, res) => {
  const startTime = Date.now();
  try {
    const { customer_message, conversation_history, instructions, thread_messages } = req.body;
    if (!instructions || instructions.trim().length < 1) return res.status(400).json({ error: 'Instructions are required' });
    if (!conversation_history || !Array.isArray(conversation_history) || conversation_history.length < 2) return res.status(400).json({ error: 'Conversation history required' });

    const user = req.user;
    const sign = user.signature_name || user.name || 'The Seller';
    const biz  = user.business_name  || 'the store';
    const tone = user.reply_tone     || 'professional';

    const systemPrompt = `You are the dedicated reply assistant for ${biz}, an eBay seller. You write customer service replies on behalf of ${sign}.\nSELLER: ${biz} | SIGNING AS: ${sign} | TONE: ${tone}\nRULES: Never suggest off-eBay contact. Never admit fault. Always end with "Best regards,\n${sign}".\nOUTPUT THE REPLY ONLY — no preamble, no explanation.`;

    const messages = [...conversation_history, { role: 'user', content: `My instruction: ${instructions.trim()}` }];
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, ...messages], max_tokens: 600, temperature: 0.5 })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message || 'OpenAI error');

    const modifiedReply = stripPreamble(aiData.choices[0].message.content.trim());
    const usage   = aiData.usage || {};
    const tokens  = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const cost    = ((usage.prompt_tokens || 0) * 0.00000015) + ((usage.completion_tokens || 0) * 0.0000006);
    const latency = Date.now() - startTime;

    await supabase.from('reply_log').insert({
      user_id: user.id, intent: 'modification', route: 'modify', model: 'gpt-4o-mini',
      customer_message: (customer_message || '').slice(0, 2000),
      generated_reply: modifiedReply.slice(0, 2000),
      modify_instructions: instructions.slice(0, 1000),
      latency_ms: latency, tokens_used: tokens, cost_usd: parseFloat(cost.toFixed(6)), source: 'extension'
    });

    analyseAndSavePreference({ userId: user.id, instruction: instructions, reply: modifiedReply, intent: req.body.intent || 'general' }).catch(() => {});

    res.json({ success: true, reply: modifiedReply, route: 'modify', model: 'gpt-4o-mini', latency_ms: latency, updated_history: [...messages, { role: 'assistant', content: modifiedReply }] });
  } catch (err) {
    console.error('[reply] Modify error:', err);
    res.status(500).json({ error: 'Failed to modify reply. Please try again.' });
  }
});

// ── Async preference analyser ─────────────────────────────────────────────
async function analyseAndSavePreference({ userId, instruction, reply, intent }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const prompt = `An eBay seller modified a reply with this instruction: "${instruction}"\nResulting reply: "${reply.slice(0, 400)}"\nWhat preference does this reveal? Return ONLY JSON: {"category":"tone|length|content|policy|greeting|closing","insight":"one clear sentence","applies_to_intent":"${intent}|null"}\nIf too vague: {"skip":true}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 120, temperature: 0.2 })
  });
  const data = await r.json();
  if (data.error) return;
  let parsed;
  try { parsed = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); } catch { return; }
  if (!parsed || parsed.skip || !parsed.insight || !parsed.category) return;
  const { data: existing } = await supabase.from('seller_preferences').select('id, times_seen').eq('user_id', userId).eq('insight', parsed.insight).single();
  if (existing) {
    await supabase.from('seller_preferences').update({ times_seen: existing.times_seen + 1, last_seen: new Date().toISOString(), source_instruction: instruction.slice(0, 500) }).eq('id', existing.id);
  } else {
    await supabase.from('seller_preferences').insert({ user_id: userId, category: parsed.category, insight: parsed.insight, applies_to_intent: parsed.applies_to_intent || null, source_instruction: instruction.slice(0, 500), times_seen: 1 });
  }
}

// ── GET /seller/insights ──────────────────────────────────────────────────
router.get('/seller/insights', requireLicense, async (req, res) => {
  try {
    const { data, error } = await supabase.from('seller_preferences')
      .select('id, category, insight, applies_to_intent, times_seen, last_seen, source_instruction')
      .eq('user_id', req.user.id).order('times_seen', { ascending: false }).limit(50);
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

// ── POST /reply/why ───────────────────────────────────────────────────────
router.post('/why', requireLicense, async (req, res) => {
  try {
    const { buyer_message, generated_reply, order_id, is_pre_purchase } = req.body;
    if (!buyer_message || !generated_reply) return res.status(400).json({ error: 'buyer_message and generated_reply required' });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI key not configured' });

    const prompt = `You are analysing an eBay customer service reply.\nBUYER MESSAGE: "${(buyer_message || '').slice(0, 500)}"\nGENERATED REPLY: "${(generated_reply || '').slice(0, 600)}"\nIS PRE-PURCHASE: ${is_pre_purchase ? 'yes' : 'no'}\nReturn ONLY JSON:\n{\n  "agent": { "name": "Senior Agent", "icon": "🏆" },\n  "paragraph": "one sentence explaining the reply strategy",\n  "structured": {\n    "risk": { "level": "low|medium|high", "label": "Low Risk|Medium Risk|High Risk" },\n    "constraints": ["2-3 short seller preference bullets"],\n    "ebayStatus": { "type": "good|warn|missing", "text": "short status line", "showConnect": false }\n  }\n}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.3 })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    let why;
    try { why = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); }
    catch { return res.status(500).json({ error: 'Failed to parse why data' }); }
    res.json({ success: true, why });
  } catch (err) {
    console.error('[reply] Why error:', err.message);
    res.status(500).json({ error: 'Failed to generate why data' });
  }
});

module.exports = router;
