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

// ── singlePassAgent — inlined to avoid extra file dependency ────────────
// agents/singlePassAgent.js — ReplyMate Pro v6.0
// ONE GPT-4o streaming call replaces Calls 1+3+4 (preClassify + reasoning + writer).
// Call 2 (riskProfit on mini) still runs in parallel but its output is advisory only.
//
// Architecture:
//   BEFORE:  Classify(4o) → [DataFetch+Risk+Prefs parallel] → Reason(4o) → Write(4o)
//            = 3 sequential GPT-4o calls = 15-25s
//
//   AFTER:   [DataFetch+Risk+Prefs parallel, ~1s] → SinglePass(4o streaming)
//            = 1 GPT-4o call, streamed = first words in ~1s, done in ~5-7s
//
// The single pass prompt does classify + reason + write in one chain-of-thought.
// It receives raw data and outputs the reply directly — no intermediate JSON round-trips.

function stripPreamble(text) {
  if (!text) return text;
  const patterns = [
    /^(here'?s?|sure[,!]?|of course[,!]?|certainly[,!]?|absolutely[,!]?).{0,80}:\s*/i,
    /^(i'?ve?|i have).{0,60}:\s*/i,
    /^(below is|here is|the (updated|revised|new) (reply|message|version)).{0,60}:\s*/i,
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

function extractSellerVoice(threadMessages) {
  if (!Array.isArray(threadMessages) || !threadMessages.length) return null;
  const msgs = threadMessages
    .filter(m => (m.role || '').toLowerCase() === 'seller')
    .map(m => (m.text || '').trim())
    .filter(t => t.length > 15);
  if (!msgs.length) return null;

  const traits = [];
  const openings = msgs.map(m => m.match(/^(Hi|Hello|Dear|Hey)[,\s]+(\w+)?/i)?.[0]).filter(Boolean);
  if (openings.length) traits.push(`Opens with: "${openings[0]}"`);

  const signoffs = msgs.map(m => m.match(/(Kind regards|Best regards|Many thanks|Thanks|Cheers|Speak soon)[,\s\n]+\w*/i)?.[0]).filter(Boolean);
  if (signoffs.length) traits.push(`Signs off: "${signoffs[0]}"`);

  const avgLen = msgs.reduce((s, m) => s + m.length, 0) / msgs.length;
  if (avgLen < 80) traits.push('Very short punchy messages');
  else if (avgLen > 280) traits.push('Detailed thorough messages');

  if (msgs.some(m => /\b(I'll|it's|we're|don't|can't)\b/.test(m))) traits.push('Uses contractions');
  if (msgs.some(m => /^(Hi|Hello|Dear)\s+[A-Z]/i.test(m))) traits.push('Addresses buyers by name');

  return traits.length ? traits : null;
}

async function singlePassAgent({
  user,
  latestBuyerMessage,
  threadMessages,
  productTitle,
  productDescription,
  orderId,
  dataFetch,
  riskData,
  sellerPrefs,
  isPrePurchase,
  res   // Express response object for streaming
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const sign = user.signature_name || user.name || 'The Seller';
  const biz  = user.business_name  || 'our store';

  // ── Build context block from available data ───────────────────────────
  const dt = dataFetch?.trace || {};
  const contextLines = [];

  if (isPrePurchase) {
    contextLines.push('⚠ PRE-PURCHASE: No order ID found. Buyer has NOT ordered yet.');
    contextLines.push('NEVER mention orders, tracking, feedback requests, or "your order".');
    contextLines.push('Treat as a potential buyer who may be deciding whether to purchase.');
  } else {
    if (orderId) contextLines.push(`Order ID: ${orderId}`);
    if (dt.tracking_found) {
      contextLines.push(`Tracking: ${[dt.tracking_carrier, dt.tracking_number].filter(Boolean).join(' ')}`);
      contextLines.push(`Delivery status: ${dt.delivery_status}`);
      if (dt.estimated_delivery) contextLines.push(`Est. delivery: ${dt.estimated_delivery}${dt.is_overdue ? ' — OVERDUE' : ''}`);
      if (dt.tracking_events?.[0]?.description) contextLines.push(`Latest event: "${dt.tracking_events[0].description}"`);
    } else if (dt.order_found) {
      contextLines.push('Order found in eBay — no tracking data available');
    }
  }

  if (productTitle) contextLines.push(`Product: ${productTitle}`);
  if (!dt.ebay_connected) contextLines.push('eBay not connected — no live order data');

  // ── Risk constraints ──────────────────────────────────────────────────
  const doNotSay  = (riskData?.doNotSayList   || []).slice(0, 6);
  const mustSay   = (riskData?.mustSayList    || []).slice(0, 4);
  const riskScore = riskData?.finalScore || 1;
  const riskLevel = riskData?.finalLevel || 'low';

  // ── Seller preferences ────────────────────────────────────────────────
  const prefBlock = (sellerPrefs || []).length > 0
    ? `\nSELLER PREFERENCES (learned from past replies):\n${sellerPrefs.slice(0,5).map(p => `• ${p.insight}`).join('\n')}`
    : '';

  // ── Thread history ────────────────────────────────────────────────────
  const thread = Array.isArray(threadMessages) && threadMessages.length > 0
    ? threadMessages.slice(-8).map(m => `${(m.role||'buyer').toUpperCase()}: ${(m.text||'').trim()}`).join('\n')
    : '(first message)';

  // ── Previous seller openings to avoid ────────────────────────────────
  const prevOpenings = Array.isArray(threadMessages)
    ? threadMessages
        .filter(m => (m.role||'').toLowerCase() === 'seller')
        .map(m => (m.text||'').trim().split('\n')[0].trim())
        .filter(Boolean).slice(-3)
    : [];

  // ── Seller voice ──────────────────────────────────────────────────────
  const voiceTraits = extractSellerVoice(threadMessages);
  const voiceBlock  = voiceTraits
    ? `\nSELLER'S VOICE — MIRROR THIS:\n${voiceTraits.map(t => `• ${t}`).join('\n')}`
    : '';

  // ── System prompt — chain-of-thought then reply ───────────────────────
  const systemPrompt = `You are an expert eBay customer service agent writing replies AS ${sign} from ${biz}.

YOUR TASK: Read the buyer message and all context. Think briefly, then write the reply.

THINKING FORMAT (do this silently before the reply):
1. What does the buyer actually want? (emotional need + practical need)
2. What is the risk level? What must I NOT say?
3. What facts from the data should I naturally weave in?
4. What tone and length fits this situation?

Then write ONLY the reply — nothing else. No "Here's the reply:", no explanation.
The reply IS your entire output after your thinking.

REPLY RULES:
• Acknowledge feeling BEFORE solution — empathy first
• Use time-anchoring: "I've just checked", "I'm looking at this now"  
• Be SPECIFIC — name the actual product, actual situation — never generic
• Use contractions naturally (I'll, it's, we're) — sound human
• One genuine interest phrase — not boilerplate
• NEVER suggest off-eBay communication
• NEVER admit fault or liability
• NEVER invent tracking numbers or dates not provided
• NEVER make promises you cannot keep
• End with: ${sign}
${voiceBlock}
${prefBlock}
${doNotSay.length ? `\nNEVER USE THESE WORDS/PHRASES: ${doNotSay.join(', ')}` : ''}
${mustSay.length  ? `\nMUST INCLUDE: ${mustSay.join(', ')}`                   : ''}
${prevOpenings.length ? `\nDO NOT repeat these opening lines: ${prevOpenings.map(o => `"${o}"`).join(', ')}` : ''}`;

  const userPrompt = `BUYER MESSAGE:
"${latestBuyerMessage}"

CONVERSATION HISTORY:
${thread}

AVAILABLE DATA:
${contextLines.length ? contextLines.map(l => `• ${l}`).join('\n') : '• No order data available'}

RISK: ${riskLevel} (${riskScore}/10)

Write the reply now.`;

  // ── Stream to client ──────────────────────────────────────────────────
  if (res) {
    res.setHeader('Content-Type',       'text/event-stream');
    res.setHeader('Cache-Control',      'no-cache, no-transform');
    res.setHeader('Connection',         'keep-alive');
    res.setHeader('X-Accel-Buffering',  'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:       'gpt-4o',
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      max_tokens:  450,
      temperature: 0.7,
      stream:      true
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err.slice(0, 200)}`);
  }

  let fullText   = '';
  let inputTok   = 0;
  let outputTok  = 0;
  let firstChunk = true;
  let buffer     = '';

  await new Promise((resolve, reject) => {
    response.body.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') { resolve(); break; }
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json  = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            if (res) {
              // Hold first 80 chars to strip any preamble before streaming
              if (firstChunk && fullText.length < 80) continue;
              if (firstChunk) {
                const cleaned = stripPreamble(fullText);
                res.write(`data: ${JSON.stringify({ type: 'chunk', text: cleaned })}\n\n`);
                fullText   = cleaned;
                firstChunk = false;
              } else {
                res.write(`data: ${JSON.stringify({ type: 'chunk', text: delta })}\n\n`);
              }
            }
          }
          if (json.usage) {
            inputTok  = json.usage.prompt_tokens     || 0;
            outputTok = json.usage.completion_tokens || 0;
          }
        } catch { /* skip */ }
      }
    });
    response.body.on('end',   resolve);
    response.body.on('error', reject);
  });

  // Flush any remaining buffer
  if (firstChunk && fullText && res) {
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: stripPreamble(fullText) })}\n\n`);
  }

  const cost = (inputTok * 0.0000025) + (outputTok * 0.00001);

  // Send metadata to client so extension can log/display
  if (res) {
    res.write(`data: ${JSON.stringify({
      type:    'done',
      intent:  'auto',
      risk:    riskLevel,
      route:   riskScore >= 7 ? 'large' : 'mini',
      tokens:  inputTok + outputTok,
      cost,
      model:   'gpt-4o'
    })}\n\n`);
    res.end();
  }

  return {
    reply:   stripPreamble(fullText),
    intent:  'auto',
    risk:    riskLevel,
    route:   riskScore >= 7 ? 'large' : 'mini',
    tokens:  inputTok + outputTok,
    cost,
    model:   'gpt-4o',
    streaming: !!res
  };
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
