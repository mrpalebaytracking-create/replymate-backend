// routes/reply.js — AI Reply Generation (all AI logic lives here, server-side)
// The extension sends customer messages here. Backend handles routing, AI calls, and usage tracking.
// Users NEVER see API keys — they are in Railway environment variables.

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const supabase = require('../db/supabase');
const { classifierAgent } = require('../agents/classifierAgent');
const { dataFetchAgent } = require('../agents/dataFetchAgent');
const { riskAgent } = require('../agents/riskAgent');
const { profitProtectionAgent } = require('../agents/profitProtectionAgent');
const { reasoningAgent } = require('../agents/reasoningAgent');
const { writerAgent } = require('../agents/writerAgent');
const { safetyCheckAgent } = require('../agents/safetyCheckAgent');

// ── License key middleware ─────────────────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });

  const { data: user } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end, name, business_name, signature_name, reply_tone')
    .eq('license_key', key)
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid license key' });

  // Owner bypasses all checks
  if (user.plan === 'owner') { req.user = user; return next(); }

  // Check plan status
  const now = new Date();
  if (user.plan === 'trial' && now > new Date(user.trial_end)) {
    return res.status(403).json({ error: 'trial_expired', message: 'Your 14-day trial has ended. Please upgrade to continue.' });
  }
  if (user.plan === 'expired') {
    return res.status(403).json({ error: 'trial_expired', message: 'Your trial has ended. Please upgrade to continue.' });
  }
  if (user.plan !== 'trial' && user.subscription_status === 'canceled') {
    if (user.subscription_end && now > new Date(user.subscription_end)) {
      return res.status(403).json({ error: 'subscription_ended', message: 'Your subscription has ended.' });
    }
  }

  req.user = user;
  next();
}



// ── Call OpenAI GPT-4o-mini ────────────────────────────────────────────────
async function callOpenAI(systemPrompt, userMessage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 500,
      temperature: 0.7
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'OpenAI API error');

  const usage = data.usage || {};
  // GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
  const cost = ((usage.prompt_tokens || 0) * 0.00000015) + ((usage.completion_tokens || 0) * 0.0000006);

  return {
    reply: data.choices[0].message.content.trim(),
    model: 'gpt-4o-mini',
    tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    cost: parseFloat(cost.toFixed(6))
  };
}

// ── Call Anthropic Claude Haiku ────────────────────────────────────────────
async function callAnthropic(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 600,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Anthropic API error');

  const usage = data.usage || {};
  // Claude 3.5 Haiku pricing: $0.80/1M input, $4.00/1M output
  const cost = ((usage.input_tokens || 0) * 0.0000008) + ((usage.output_tokens || 0) * 0.000004);

  return {
    reply: data.content[0].text.trim(),
    model: 'claude-3-5-haiku-20241022',
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    cost: parseFloat(cost.toFixed(6))
  };
}


// ── Build "Why This Answer" payload ───────────────────────────────────────
// Assembles a clean, seller-facing explanation from already-computed pipeline data.
// No new DB queries. No AI calls. No financial information exposed.
function buildWhyData({ intent, route, risk, classifier, dataFetch, reasoning, latency, latestBuyerMessage }) {

  // ── 1) Agent identity ──────────────────────────────────────────────────
  const agents = {
    rule:  { name: 'Junior Agent',    icon: '📋' },
    mini:  { name: 'Senior Agent',    icon: '✍️'  },
    large: { name: 'Risk Specialist', icon: '🛡️' }
  };
  const agent = agents[route] || agents.mini;

  // ── 2) eBay data context ───────────────────────────────────────────────
  const ebayConnected  = !dataFetch.missing.includes('ebay_oauth');
  const hasOrderData   = !!(dataFetch.fetched && dataFetch.fetched.order);
  const hasTracking    = !!(dataFetch.fetched && dataFetch.fetched.tracking && dataFetch.fetched.tracking.length > 0 && dataFetch.fetched.tracking[0].trackingNumber);
  const orderIdFound   = !!(classifier.extracted && classifier.extracted.orderId);

  // ── 3) Paragraph — Style B (reassuring, warm, no financials) ──────────
  let paragraph = '';

  if (route === 'rule') {
    // Junior Agent paragraphs — positive_feedback is message-aware
    if (intent === 'positive_feedback') {
      const msg = (latestBuyerMessage || '').trim().toLowerCase();
      if (/^(fine|alright|ok|okay|sure|noted|understood|all good)[\s!.]*$/i.test(msg)) {
        paragraph = "Your buyer sent a brief acknowledgement — a one-word reply that just needs a clean, professional close. Your Junior Agent handled it instantly. There's no question to answer here, so the reply keeps things warm and leaves the door open without saying anything unnecessary.";
      } else if (/pleasure|my pleasure/i.test(msg)) {
        paragraph = "Your buyer is being polite and wrapping up the conversation. Your Junior Agent replied in kind — short, warm, and proportionate. Matching your buyer's tone here builds goodwill without overdoing it.";
      } else if (/thank/i.test(msg)) {
        paragraph = "Your buyer is saying thanks — this needed a warm, genuine response, not a long one. Your Junior Agent handled it instantly. Keeping it short is the right call here: over-responding to a simple thank you can feel awkward or pushy. Clean, friendly, done.";
      } else if (/great|brilliant|excellent|amazing|wonderful|fantastic|perfect/i.test(msg)) {
        paragraph = "Your buyer left positive feedback on the transaction. Your Junior Agent replied briefly and warmly — enough to acknowledge the compliment without sounding scripted. Short positive exchanges like this are great for your seller reputation.";
      } else if (/happy|pleased|love|satisfied/i.test(msg)) {
        paragraph = "Your buyer is expressing satisfaction. Your Junior Agent kept the reply short and genuine — the right tone for a conversation that's ending well. No need to oversell it, just close it cleanly.";
      } else {
        paragraph = "Your buyer sent a short, positive message. Your Junior Agent replied warmly and kept it brief — matching the buyer's energy is the right move here. A proportionate reply feels more natural and genuine than a long response to a short message.";
      }
    } else {
      const juniorParagraphs = {
        off_platform:     "Your buyer tried to move the conversation off eBay. Your Junior Agent replied with a polite but firm refusal that keeps everything on-platform. This protects you — transactions and disputes handled outside eBay are not covered by seller protection.",
        shipping_inquiry: "Your buyer had a standard shipping question. Your Junior Agent answered using a proven template — consistent, accurate, and safe. Nothing in here makes delivery promises that your listing doesn't already support.",
        item_question:    "Your buyer asked a product question. Your Junior Agent pointed them to the listing — the right answer every time, because it avoids you committing to specs you might misremember under pressure.",
      };
      paragraph = juniorParagraphs[intent] || "This was a routine message that matched a proven reply template. Your Junior Agent handled it instantly. The reply is professional, accurate, and keeps you covered.";
    }

  } else if (route === 'large') {
    // Risk Specialist paragraphs — always high risk
    const riskParagraphs = {
      legal_threat:  "I spotted legal language in this message and your Risk Specialist took over immediately. The reply is deliberately neutral — it doesn't agree with the buyer, doesn't argue back, and doesn't put anything in writing that could be used against you. Redirecting to eBay's Resolution Centre is the correct move: it shows good faith, keeps everything documented, and keeps your seller protection intact.",
      fraud_claim:   "Your buyer is making a fraud or authenticity claim — your Risk Specialist handled this one. The reply calmly defends your product without getting defensive or aggressive. It opens a path to resolution without admitting anything. This is the exact tone that prevents cases like this from escalating into formal disputes.",
      off_platform:  "Your buyer attempted to move this conversation off eBay — your Risk Specialist flagged it immediately. Communicating or transacting outside eBay removes your seller protection entirely. The reply refuses politely without making your buyer feel accused.",
    };
    paragraph = riskParagraphs[intent] || "Your Risk Specialist reviewed this message and handled it with extra care. The reply is precise — every word chosen to protect you. No fault admitted, no promises made, no escalation.";

  } else {
    // Senior Agent paragraphs — intent + data aware
    if (intent === 'tracking') {
      if (hasTracking) {
        paragraph = "Your buyer wants to know where their order is. I found the tracking details directly from your eBay account and included the real information in the reply — your buyer gets a proper answer instead of being told to find it themselves. The reply is short on purpose: one question deserves one answer. No delivery date promises were made.";
      } else if (ebayConnected && !orderIdFound) {
        paragraph = "Your buyer wants to know where their order is. I couldn't match this to a specific order because no order ID was found in the conversation, so I wrote a helpful reply and asked your buyer to check their eBay notifications. If an order number appears in future messages, I'll pull the live tracking details automatically.";
      } else if (!ebayConnected) {
        paragraph = "Your buyer wants to know where their order is. Since your eBay account isn't connected, I wrote a helpful reply without live order data and directed your buyer to their eBay notifications. Connect your eBay account and I'll include the real tracking number automatically next time.";
      } else {
        paragraph = "Your buyer wants to know where their order is. I wrote a helpful reply based on the information available. Your Senior Agent kept the tone calm, avoided delivery date promises, and directed your buyer to the right place.";
      }
    } else if (intent === 'return') {
      paragraph = "Your buyer wants to return something. Your Senior Agent handled this carefully — the reply acknowledges the request without agreeing to a refund upfront, and guides your buyer through eBay's official return process. That protects you: no promises made, no liability accepted, everything kept on-platform.";
    } else if (intent === 'refund') {
      paragraph = "Your buyer is asking for a refund. Your Senior Agent acknowledged the concern professionally without committing to anything. The reply guides your buyer through eBay's resolution process — the right route because it keeps everything documented and protects both parties.";
    } else if (intent === 'damaged_item') {
      paragraph = "Your buyer says their item arrived damaged. Your Senior Agent responded with empathy and asked for photos before anything else — that's important, because documentation protects you before any resolution is offered. No fault has been admitted and no refund has been promised.";
    } else if (intent === 'cancellation') {
      paragraph = "Your buyer wants to cancel their order. Your Senior Agent assessed the situation and replied carefully. The wording keeps your options open without being dismissive — if the order is already dispatched, your buyer is guided toward the return process instead.";
    } else if (intent === 'discount_request') {
      paragraph = "Your buyer is trying to negotiate on price. Your Senior Agent declined politely without being dismissive — the reply holds your position without damaging the relationship. Your buyer feels heard even though the answer is no.";
    } else if (intent === 'shipping_inquiry') {
      paragraph = "Your buyer had a shipping question. Your Senior Agent gave a clear, helpful answer. Nothing in this reply makes delivery promises that your listing doesn't already support — that's intentional, because delivery promises are the most common source of negative feedback when things run late.";
    } else if (intent === 'item_question') {
      paragraph = "Your buyer asked a product question. Your Senior Agent answered helpfully while pointing to the listing for full details — this protects you from committing to specs you might not have at hand. Accurate, professional, and safe.";
    } else {
      // General fallback — varies by message length and tone so no two feel the same
      const msgLen   = (latestBuyerMessage || '').trim().length;
      const msgLower = (latestBuyerMessage || '').toLowerCase();

      if (msgLen <= 15) {
        // Very short — one or two words like "Fine", "Noted", "OK sounds good"
        paragraph = "Your buyer sent a short acknowledgement — this needed a brief, warm reply that closes the conversation cleanly without over-explaining. Your Senior Agent kept it proportionate. A long response to a short message can feel odd, so the reply matches the buyer's energy.";
      } else if (msgLower.includes('sorry') || msgLower.includes('apologise') || msgLower.includes('apologize') || msgLower.includes('my fault') || msgLower.includes('my mistake')) {
        paragraph = "Your buyer is apologising or acknowledging an issue. Your Senior Agent replied warmly without over-reassuring or making commitments. The tone keeps the relationship positive while keeping you covered — no admissions, no promises, nothing that could be used against you later.";
      } else if (msgLower.includes('wait') || msgLower.includes('patient') || msgLower.includes('understand')) {
        paragraph = "Your buyer is showing patience or expressing understanding — a good sign. Your Senior Agent replied warmly to reinforce that goodwill without making delivery promises or setting expectations you might not be able to meet. Short, appreciative, and safe.";
      } else if (msgLen > 200) {
        // Long detailed message
        paragraph = "Your buyer sent a detailed message. Your Senior Agent read it carefully and addressed the main concern without getting drawn into side points. The reply is focused — covering what matters, keeping the tone professional, and avoiding anything that could create liability or misunderstanding.";
      } else {
        paragraph = "Your Senior Agent reviewed this message and kept the reply professional and precise. Nothing in here creates liability, makes promises, or suggests off-platform communication — the three things most likely to cause problems with eBay sellers.";
      }
    }
  }

  // ── 4) Structured bits ─────────────────────────────────────────────────
  const riskLabels = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' };

  // Pull constraints from reasoning (max 4, clean language)
  const constraints = (reasoning.constraints || []).slice(0, 4);

  // eBay data status line
  let ebayStatus = null;
  if (hasTracking) {
    const t = dataFetch.fetched.tracking[0];
    ebayStatus = { type: 'good', text: `Live tracking used: ${t.carrier ? t.carrier + ' ' : ''}${t.trackingNumber}` };
  } else if (hasOrderData) {
    ebayStatus = { type: 'good', text: 'Live order data used from your eBay account' };
  } else if (ebayConnected && ['tracking','return','refund','damaged_item','cancellation'].includes(intent)) {
    ebayStatus = { type: 'warn', text: 'eBay connected but no order ID found in this conversation' };
  } else if (!ebayConnected && ['tracking','return','refund','damaged_item','cancellation'].includes(intent)) {
    ebayStatus = { type: 'missing', text: 'eBay not connected — reply written without live order data', showConnect: true };
  }

  return {
    agent,
    paragraph,
    structured: {
      risk:        { level: risk, label: riskLabels[risk] || 'Low Risk' },
      constraints,
      ebayStatus,
      latency_ms:  latency
    }
  };
}

// ── POST /reply/generate — main reply generation endpoint ──────────────────
router.post('/generate', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
const {
  customer_message,
  latest_buyer_message,
  thread_messages,
  modify_instructions,
  buyer_name,
  order_id
} = req.body;

const latestBuyerMessage = (latest_buyer_message || customer_message || '').trim();
const threadMessages = Array.isArray(thread_messages) ? thread_messages : [];

    if (!latestBuyerMessage || latestBuyerMessage.length < 3) {
      return res.status(400).json({ error: 'Customer message is required' });
    }

    const user = req.user;

    // Step 1: Classify intent
    // ── AGENT PIPELINE ─────────────────────────────────────────────

// 1) Classifier Agent
const classifier = classifierAgent({
  latestBuyerMessage,
  threadMessages
});

// allow order_id from extension to override extraction
const resolvedOrderId = order_id || classifier.extracted.orderId;

// 2) Data Fetch Agent (only if needed)
const dataFetch = await dataFetchAgent({
  userId: user.id,
  needs: classifier.needs,
  orderId: resolvedOrderId
});

// 3) Risk Agent
const riskOut = riskAgent({ intent: classifier.intent, risk: classifier.risk });

// 4) Profit Protection Agent
const profitOut = profitProtectionAgent({
  intent: classifier.intent,
  fetched: dataFetch.fetched
});

// 5) Reasoning Agent (facts + missing info + constraints)
const reasoning = reasoningAgent({
  classifier,
  dataFetch,
  risk: riskOut,
  profit: profitOut
});

// 5b) Load seller preferences and inject into reasoning constraints
// Wrapped in try/catch — if this fails for ANY reason, generate continues normally
try {
  const { data: prefRows } = await supabase
    .from('seller_preferences')
    .select('insight, applies_to_intent, times_seen')
    .eq('user_id', user.id)
    .or(`applies_to_intent.eq.${classifier.intent},applies_to_intent.is.null`)
    .order('times_seen', { ascending: false })
    .limit(6);

  if (prefRows && prefRows.length > 0) {
    const prefLines = prefRows.map(p => p.insight);
    reasoning.constraints = [...(reasoning.constraints || []), ...prefLines];
  }
} catch (prefErr) {
  // Non-fatal — preferences are a nice-to-have, not required for generation
  console.warn('Could not load seller preferences (non-fatal):', prefErr.message);
}

// ── Rule-based short-circuit (Junior Agent) ─────────────────────────────
// Fires BEFORE writerAgent for routine, low-risk, short messages.
// These need no AI — a polished template is faster and just as good.
const sign = user.signature_name || user.name || 'The Seller';
const biz  = user.business_name  || 'our store';
const msgLen = latestBuyerMessage.trim().length;

const juniorTemplates = {
  positive_feedback: `You're welcome! If you ever need anything, don't hesitate to reach out.\n\nBest regards,\n${sign}`,
  off_platform:      `Hi,\n\nThank you for your message. For the protection of both parties, I keep all communication and transactions through eBay's official system.\n\nPlease continue here — happy to help with anything you need.\n\nBest regards,\n${sign}`,
  shipping_inquiry:  `Hi,\n\nThank you for your interest! Shipping details and estimated delivery times are listed on each item's page. If you have a specific question about delivery to your location, feel free to ask.\n\nBest regards,\n${sign}`,
  item_question:     `Hi,\n\nThank you for your question! All product details, dimensions, and compatibility information are listed in the item description — I'd recommend checking there first.\n\nIf you can't find what you need, just let me know and I'll be happy to help.\n\nBest regards,\n${sign}`,
};

// Conditions for Junior Agent:
// - intent has a template AND
// - low risk AND
// - either it's a positive_feedback/off_platform (always template) OR message is short (< 80 chars)
const alwaysTemplate = ['positive_feedback', 'off_platform'].includes(classifier.intent);
const shortAndSimple = ['shipping_inquiry', 'item_question'].includes(classifier.intent) && msgLen < 80;

let result;

if (juniorTemplates[classifier.intent] && classifier.risk === 'low' && (alwaysTemplate || shortAndSimple)) {
  result = {
    reply:  juniorTemplates[classifier.intent],
    model:  'rule',
    tokens: 0,
    cost:   0
  };
} else {

// 6) Writer Agent (AI)
try {
  result = await writerAgent({
    user,
    latestBuyerMessage,
    threadMessages,
    reasoning,
    riskLevel: classifier.risk
  });
} catch (err) {
  console.error('Writer agent failed:', err.message);
  return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
}

// 7) Safety Check Agent (final pass)
const safe = safetyCheckAgent({ draft: result.reply });
result = { ...result, reply: safe.reply };

} // end Junior Agent else block

const reply  = result.reply;
const model  = result.model;
const tokens = result.tokens;
const cost   = result.cost;

// Determine route label
const route = model === 'gpt-4o-mini' ? 'mini' : model.startsWith('claude') ? 'large' : 'rule';

// return intent/risk from classifier
const intent = classifier.intent;
const risk = classifier.risk;

    const latency = Date.now() - startTime;

    // Step 4: Track usage (fire and forget — don't block the response)
    const today = new Date().toISOString().split('T')[0];

    // Upsert daily usage
    const { data: existing } = await supabase
      .from('usage')
      .select('id, replies_count, rule_count, mini_count, large_count, tokens_used, cost_usd')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();

    if (existing) {
      await supabase.from('usage').update({
        replies_count: existing.replies_count + 1,
        rule_count: existing.rule_count + (route === 'rule' ? 1 : 0),
        mini_count: existing.mini_count + (route === 'mini' ? 1 : 0),
        large_count: existing.large_count + (route === 'large' ? 1 : 0),
        tokens_used: existing.tokens_used + (tokens || 0),
        cost_usd: parseFloat(existing.cost_usd) + (cost || 0)
      }).eq('id', existing.id);
    } else {
      await supabase.from('usage').insert({
        user_id: user.id,
        date: today,
        replies_count: 1,
        rule_count: route === 'rule' ? 1 : 0,
        mini_count: route === 'mini' ? 1 : 0,
        large_count: route === 'large' ? 1 : 0,
        tokens_used: tokens || 0,
        cost_usd: cost || 0
      });
    }

    // Log individual reply
    await supabase.from('reply_log').insert({
      user_id: user.id,
      intent,
      route,
      model,
      customer_message: latestBuyerMessage.slice(0, 2000),
      generated_reply: reply.slice(0, 2000),
      modify_instructions: modify_instructions || null,
      latency_ms: latency,
      tokens_used: tokens || 0,
      cost_usd: cost || 0,
      source: 'extension'
    });

    // Update last_active
    await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id);

    // Step 5: Return reply
    const debug = req.query.debug === '1';

    // Build why payload from already-computed pipeline data (no extra cost, no extra queries)
    const why = buildWhyData({ intent, route, risk, classifier, dataFetch, reasoning, latency, latestBuyerMessage });

res.json({
  success: true,
  reply,
  intent,
  risk,
  route,
  latency_ms: latency,
  why,
  ...(debug ? { agents: { classifier, dataFetch, riskOut, profitOut, reasoning } } : {})
});


  } catch (err) {
    console.error('Reply generation error:', err);
    res.status(500).json({ error: 'Failed to generate reply. Please try again.' });
  }
});

// ── POST /reply/modify — full GPT conversation, long-input aware ──────────
router.post('/modify', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      customer_message,
      conversation_history, // array of {role, content} — the real GPT thread
      instructions,         // current instruction from seller (can be long)
      thread_messages       // eBay thread for extra context
    } = req.body;

    if (!instructions || instructions.trim().length < 1) {
      return res.status(400).json({ error: 'Instructions are required' });
    }
    if (!conversation_history || !Array.isArray(conversation_history) || conversation_history.length < 2) {
      return res.status(400).json({ error: 'Conversation history required' });
    }

    const user = req.user;
    const sign = user.signature_name || user.name || 'The Seller';
    const biz  = user.business_name  || 'the store';
    const tone = user.reply_tone     || 'professional';

    // ── System prompt — tells GPT exactly who it is and what it must do ──
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
7. If the seller's instruction is a question or asks for your opinion — answer it conversationally first, then offer to rewrite the reply.

YOU HAVE FULL CONTEXT of the buyer's message and every previous version of this reply. Build on that context.`;

    // ── Build the messages array — this is a real GPT conversation ────────
    // conversation_history already contains the full thread:
    // [ {role:'user', content:'Buyer said: ...\n\nWrite a reply.'}, {role:'assistant', content:'...'}, ... ]
    // We just append the new instruction as the next user turn.
    const messages = [
      ...conversation_history,
      { role: 'user', content: `My instruction: ${instructions.trim()}` }
    ];

    // ── Call OpenAI with the full conversation ─────────────────────────────
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        max_tokens: 800,    // generous — seller may have asked for a long reply
        temperature: 0.5    // lower than generate — follow instructions precisely
      })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message || 'OpenAI error');

    const modifiedReply = aiData.choices[0].message.content.trim();
    const usage  = aiData.usage || {};
    const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const cost   = ((usage.prompt_tokens || 0) * 0.00000015) + ((usage.completion_tokens || 0) * 0.0000006);
    const latency = Date.now() - startTime;

    // ── Log the modification ───────────────────────────────────────────────
    await supabase.from('reply_log').insert({
      user_id:              user.id,
      intent:               'modification',
      route:                'modify',
      model:                'gpt-4o-mini',
      customer_message:     (customer_message || '').slice(0, 2000),
      generated_reply:      modifiedReply.slice(0, 2000),
      modify_instructions:  instructions.slice(0, 1000),
      latency_ms:           latency,
      tokens_used:          tokens,
      cost_usd:             parseFloat(cost.toFixed(6)),
      source:               'extension'
    });

    // ── Fire-and-forget: async preference analysis ─────────────────────────
    // Non-blocking — seller gets their reply instantly, analysis runs in background
    analyseAndSavePreference({
      userId:      user.id,
      instruction: instructions,
      reply:       modifiedReply,
      intent:      req.body.intent || 'general'
    }).catch(err => console.error('Preference analysis failed silently:', err.message));

    // ── Return ─────────────────────────────────────────────────────────────
    res.json({
      success:    true,
      reply:      modifiedReply,
      route:      'modify',
      model:      'gpt-4o-mini',
      latency_ms: latency,
      // Return the updated history so frontend can continue the conversation
      updated_history: [
        ...messages,
        { role: 'assistant', content: modifiedReply }
      ]
    });

  } catch (err) {
    console.error('Reply modification error:', err);
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.2
    })
  });

  const data = await r.json();
  if (data.error) return;

  let parsed;
  try {
    const text = data.content?.[0]?.text || data.choices?.[0]?.message?.content || '';
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch { return; }

  if (!parsed || parsed.skip || !parsed.insight || !parsed.category) return;

  // Upsert: if same insight exists for this user, increment times_seen
  const { data: existing } = await supabase
    .from('seller_preferences')
    .select('id, times_seen')
    .eq('user_id', userId)
    .eq('insight', parsed.insight)
    .single();

  if (existing) {
    await supabase.from('seller_preferences').update({
      times_seen: existing.times_seen + 1,
      last_seen:  new Date().toISOString(),
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


// ── GET /seller/insights — returns preferences for the popup dashboard ─────
router.get('/seller/insights', requireLicense, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_preferences')
      .select('id, category, insight, applies_to_intent, times_seen, last_seen, source_instruction')
      .eq('user_id', req.user.id)
      .order('times_seen', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Group by category for the UI
    const grouped = {};
    for (const row of (data || [])) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }

    res.json({ success: true, total: (data || []).length, grouped });
  } catch (err) {
    console.error('Insights fetch error:', err);
    res.status(500).json({ error: 'Failed to load insights' });
  }
});


module.exports = router;
