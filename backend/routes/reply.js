// routes/reply.js — ReplyMate Pro v6.0
//
// NEW ARCHITECTURE — 2 parallel calls, 1 sequential:
//
//   PARALLEL (after message detection):
//     ├── dataFetchAgent    (eBay API, no AI)
//     ├── riskProfitAgent   (GPT-4o-mini, ~1s)
//     └── seller prefs      (Supabase query)
//
//   THEN: singlePassAgent   (GPT-4o, STREAMING — first words in ~1s)
//
// Total time: ~3-6s vs previous 15-25s
// Junior Agent (regex templates) still runs before any AI for simple intents.

const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../db/supabase');

const { dataFetchAgent }  = require('../agents/dataFetchAgent');
const { riskProfitAgent } = require('../agents/riskProfitAgent');
const { singlePassAgent } = require('../agents/singlePassAgent');

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

// ── Junior Agent templates ────────────────────────────────────────────────
function runJuniorAgent(user, intent, msg) {
  const sign  = user.signature_name || user.name || 'The Seller';
  const lower = (msg || '').toLowerCase().trim();

  const templates = {
    positive_feedback: () => {
      if (/arrived|received|got it/i.test(lower))   return `Glad to hear it arrived safely — enjoy it!\n\nBest regards,\n${sign}`;
      if (/fast|quick|speedy|prompt/i.test(lower))  return `Really appreciate that — glad it reached you quickly!\n\nBest regards,\n${sign}`;
      if (/perfect|exactly what|as described/i.test(lower)) return `That's great to hear, thank you! Really glad it's exactly what you were looking for.\n\nBest regards,\n${sign}`;
      if (/great|brilliant|excellent|amazing/i.test(lower)) return `Thank you so much — that really means a lot!\n\nBest regards,\n${sign}`;
      if (/thank|thanks/i.test(lower))              return `You're welcome! Don't hesitate to reach out if you need anything.\n\nBest regards,\n${sign}`;
      return `You're welcome! Really glad everything worked out well.\n\nBest regards,\n${sign}`;
    },
    off_platform: () =>
      `Hi,\n\nThank you for your message. For the protection of both of us, I keep all communication and transactions through eBay's official system.\n\nHappy to help with anything you need right here.\n\nBest regards,\n${sign}`,
    shipping_inquiry: () =>
      `Hi,\n\nThanks for your message! Full shipping details and estimated delivery times are listed on each item's page. If you have a specific question about delivery to your location, just ask and I'll help.\n\nBest regards,\n${sign}`,
    item_question: () =>
      `Hi,\n\nGreat question! All product details and specifications are in the item description — well worth checking there first.\n\nIf you can't find what you need, just let me know and I'll be happy to help.\n\nBest regards,\n${sign}`,
    dispatch_confirmation: () =>
      `Hi,\n\nThank you for your message! Your order will be dispatched within our stated handling time and you'll receive a tracking notification from eBay as soon as it's on its way.\n\nBest regards,\n${sign}`,
    combined_shipping: () =>
      `Hi,\n\nAbsolutely — happy to combine postage. Just add everything to your basket and message me requesting a revised total before paying.\n\nBest regards,\n${sign}`,
    payment_confirmation: () =>
      `Hi,\n\nThank you — payment received! Your order is now being processed and I'll get it dispatched as soon as possible.\n\nBest regards,\n${sign}`,
    availability: () =>
      `Hi,\n\nThanks for your interest! Everything currently available is listed on eBay. Feel free to ask if you're looking for something specific.\n\nBest regards,\n${sign}`,
  };

  if (!templates[intent]) return null;
  return { reply: templates[intent](), model: 'rule', route: 'rule', tokens: 0, cost: 0 };
}

// ── Quick regex classifier for Junior Agent gating (no AI needed) ────────
function quickClassify(msg) {
  const t = (msg || '').toLowerCase();
  if (/\b(thank|thanks|great seller|brilliant|excellent|arrived|received|got it|perfect|as described|happy with|well packaged|would recommend)\b/.test(t)) return 'positive_feedback';
  if (/\b(whatsapp|telegram|email me|call me|text me|outside ebay|personal (email|number))\b/.test(t)) return 'off_platform';
  if (/\b(how much (is|for) (postage|shipping|delivery)|do you ship to|how long (will|does) (delivery|shipping)|postage to)\b/.test(t)) return 'shipping_inquiry';
  if (/\b(just paid|payment sent|i('ve| have) paid|please confirm payment)\b/.test(t)) return 'payment_confirmation';
  if (/\b(combine (postage|shipping)|buying (more|multiple)|combined shipping)\b/.test(t)) return 'combined_shipping';
  if (/\b(still (in|have) stock|still available|do you (have|stock)|any (more|left))\b/.test(t)) return 'availability';
  if (/\b(when (will you|are you) (send|dispatch|ship)|has it been (dispatched|posted|sent)|when (is it|will it) (be sent|ship))\b/.test(t)) return 'dispatch_confirmation';
  if (/\b(does it (come with|include|fit|work with)|compatible with|what (size|colour|color|material)|is it|measurements|dimensions|how (big|long|wide|tall))\b/.test(t)) return 'item_question';
  return null;
}

// ── Junior Agent gating — pure regex, no AI ──────────────────────────────
function shouldRunJuniorAgent(intent, msg, threadMessages, isPrePurchase) {
  if (!intent) return { fire: false };

  // Never for pre-purchase if question might need a specific answer
  if (['item_question', 'shipping_inquiry'].includes(intent) && isPrePurchase) {
    // Still ok — these are pre-purchase by nature
  }

  const complexitySignals = /\b(already|still|yet|weeks?|days?|supposed to|should have|tried|before|again|chased|contacted|previous|last time|still waiting|still haven't|unhappy|disappointed|angry|frustrated)\b/i;
  if (complexitySignals.test(msg)) return { fire: false, reason: 'complexity signals detected' };

  // Never run templates on long messages — they have nuance
  if (msg.trim().length > 130) return { fire: false, reason: 'message too long for template' };

  // Count seller messages in thread — if seller has replied multiple times, needs full pipeline
  const sellerMsgCount = (threadMessages || []).filter(m => (m.role || '').toLowerCase() === 'seller').length;
  if (sellerMsgCount > 2) return { fire: false, reason: 'ongoing conversation' };

  if (intent === 'positive_feedback') return { fire: true, reason: 'positive feedback — template' };
  if (intent === 'off_platform')      return { fire: true, reason: 'off-platform request — template' };

  const shortTemplateIntents = ['shipping_inquiry', 'item_question', 'dispatch_confirmation', 'combined_shipping', 'payment_confirmation', 'availability'];
  if (shortTemplateIntents.includes(intent)) return { fire: true, reason: `${intent} — simple template` };

  return { fire: false };
}

// ── Strip preamble ────────────────────────────────────────────────────────
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

// ── POST /reply/generate — streaming SSE endpoint ────────────────────────
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

    const threadMessages = Array.isArray(thread_messages) ? thread_messages : [];

    // ── Detect correct buyer message ─────────────────────────────────────
    // Extension sometimes sends the seller's own last message — detect and fix.
    let latestBuyerMessage = (latest_buyer_message || customer_message || '').trim();

    if (threadMessages.length > 0) {
      const lastMsg  = threadMessages[threadMessages.length - 1];
      const lastRole = (lastMsg?.role || '').toLowerCase();
      if (lastRole === 'seller' && latestBuyerMessage === (lastMsg?.text || '').trim()) {
        const lastBuyer = [...threadMessages].reverse()
          .find(m => (m.role || '').toLowerCase() === 'buyer' && (m.text || '').trim().length > 2);
        if (lastBuyer) latestBuyerMessage = lastBuyer.text.trim();
      }
    }
    if (!latestBuyerMessage || latestBuyerMessage.length < 3) {
      const lastBuyer = [...threadMessages].reverse()
        .find(m => (m.role || '').toLowerCase() === 'buyer' && (m.text || '').trim().length > 2);
      if (lastBuyer) latestBuyerMessage = lastBuyer.text.trim();
    }
    if (!latestBuyerMessage || latestBuyerMessage.length < 3)
      return res.status(400).json({ error: 'No buyer message found to reply to.' });

    const user           = req.user;
    const isPrePurchase  = is_pre_purchase === true || is_pre_purchase === 'true' || !order_id;
    const orderId        = order_id || null;

    // ── Quick regex classify for Junior Agent ─────────────────────────────
    const quickIntent = quickClassify(latestBuyerMessage);
    const jGating     = shouldRunJuniorAgent(quickIntent, latestBuyerMessage, threadMessages, isPrePurchase);

    if (jGating.fire) {
      const juniorResult = runJuniorAgent(user, quickIntent, latestBuyerMessage);
      if (juniorResult) {
        const latency = Date.now() - startTime;
        trackUsage(user.id, 'rule', 0, 0).catch(() => {});
        logReply(user.id, quickIntent, 'rule', 'rule', latestBuyerMessage, juniorResult.reply, latency, 0, 0).catch(() => {});
        return res.json({
          success:    true,
          reply:      juniorResult.reply,
          intent:     quickIntent,
          risk:       'low',
          route:      'rule',
          latency_ms: latency
        });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PARALLEL: DataFetch + RiskProfit(mini) + SellerPrefs — all at once
    // ════════════════════════════════════════════════════════════════════
    const needsOrder = !isPrePurchase;

    const [dataFetch, riskProfit, prefRows] = await Promise.all([
      dataFetchAgent({ userId: user.id, needs: { order: needsOrder }, orderId }),
      riskProfitAgent({
        classification:    { primaryIntent: quickIntent || 'general', allIntents: [{ intent: quickIntent || 'general', confidence: 0.8 }], risk: 'low', riskScore: 2, buyerTone: 'neutral', manipulationFlag: false, manipulationReason: null, implicitSignals: [], entities: { orderId, buyerName: null, amountsMentioned: [], datesMentioned: [], carriersMentioned: [], productsMentioned: [] }, languageStyle: 'unknown', suggestedEscalation: 'senior', shouldUseJuniorAgent: false, juniorAgentReason: '' },
        conversationState: { messageCount: threadMessages.length + 1, isFirstContact: threadMessages.length === 0, previousIntents: [], toneTrajectory: 'stable', sellerPreviousPromises: [], existingEbayCase: false, relationshipScore: 1 },
        dataFetch:         { fetched: {}, trace: {}, missing: [] },
        productTitle:      product_title || '',
        orderValue:        null
      }),
      supabase
        .from('seller_preferences')
        .select('insight, applies_to_intent, times_seen')
        .eq('user_id', user.id)
        .order('times_seen', { ascending: false })
        .limit(5)
        .then(r => r.data || [])
        .catch(() => [])
    ]);

    // Apply pre-purchase constraints to risk
    const risk = riskProfit.risk || {};
    if (isPrePurchase) {
      risk.doNotSayList = [
        ...(risk.doNotSayList || []),
        'your order', 'tracking', 'dispatched', 'feedback', 'positive review', 'leave a review'
      ];
    }
    if (prefRows.length > 0)
      risk.constraints = [...(risk.constraints || []), ...prefRows.map(p => p.insight)];

    // ════════════════════════════════════════════════════════════════════
    // SINGLE PASS — GPT-4o streaming — does classify+reason+write in one
    // ════════════════════════════════════════════════════════════════════
    let finalReply = '';
    let finalTokens = 0;
    let finalCost   = 0;
    let finalRoute  = 'mini';

    try {
      const result = await singlePassAgent({
        user,
        latestBuyerMessage,
        threadMessages,
        productTitle:       product_title       || '',
        productDescription: product_description || '',
        orderId,
        dataFetch,
        riskData:     risk,
        sellerPrefs:  prefRows,
        isPrePurchase,
        res   // <-- pass Express res for streaming
      });

      finalReply  = result.reply   || '';
      finalTokens = result.tokens  || 0;
      finalCost   = result.cost    || 0;
      finalRoute  = result.route   || 'mini';
    } catch (err) {
      console.error('[reply] singlePassAgent failed:', err.message);
      if (!res.headersSent)
        return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
      return;
    }

    const latency = Date.now() - startTime;

    // Fire-and-forget logging (res already sent via streaming)
    trackUsage(user.id, finalRoute, finalTokens, finalCost).catch(() => {});
    logReply(user.id, quickIntent || 'general', finalRoute, 'gpt-4o', latestBuyerMessage, finalReply, latency, finalTokens, finalCost).catch(() => {});
    supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});

  } catch (err) {
    console.error('[reply] Generate error:', err);
    if (!res.headersSent)
      res.status(500).json({ error: 'Failed to generate reply. Please try again.' });
  }
});

// ── Usage tracking ────────────────────────────────────────────────────────
async function trackUsage(userId, route, tokens, cost) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('usage')
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
      rule_count: route === 'rule' ? 1 : 0, mini_count: route === 'mini' ? 1 : 0, large_count: route === 'large' ? 1 : 0,
      tokens_used: tokens || 0, cost_usd: cost || 0
    });
  }
}

// ── Reply log ─────────────────────────────────────────────────────────────
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

    const systemPrompt = `You are the dedicated reply assistant for ${biz}, an eBay seller. You write customer service replies on behalf of ${sign}.
SELLER: ${biz} | SIGNING AS: ${sign} | TONE: ${tone}
RULES: Never suggest off-eBay contact. Never admit fault. Always end with "Best regards,\\n${sign}".
OUTPUT THE REPLY ONLY — no preamble, no explanation.`;

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

    analyseAndSavePreference({ userId: user.id, instruction: instructions, reply: modifiedReply, intent: req.body.intent || 'general' })
      .catch(() => {});

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

module.exports = router;
