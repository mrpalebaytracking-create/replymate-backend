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

// ── Intent classification ──────────────────────────────────────────────────
function classifyIntent(message) {
  const msg = message.toLowerCase();

  const patterns = {
    tracking:         [/track/i, /where.*(order|package|item|shipment)/i, /shipping status/i, /when.*(arrive|deliver|ship|get)/i, /hasn.t (arrived|shipped)/i, /not received/i, /delivery date/i],
    return:           [/return/i, /send.*(back|it back)/i, /want.*refund/i, /return (policy|label|request)/i, /exchange/i],
    refund:           [/refund/i, /money back/i, /charge.*back/i, /full refund/i, /partial refund/i, /reimburse/i],
    damaged_item:     [/damaged/i, /broken/i, /cracked/i, /dent/i, /scratch/i, /defective/i, /not working/i, /doesn.t work/i, /faulty/i, /arrived broken/i],
    shipping_inquiry: [/shipping (cost|time|method|option)/i, /how long.*(ship|deliver)/i, /expedit/i, /express ship/i, /free shipping/i, /international ship/i],
    item_question:    [/compatible/i, /does (it|this) (work|fit|come)/i, /what.*(size|color|dimension|weight|material)/i, /is (it|this) (new|genuine|authentic|original)/i, /specs/i, /specification/i],
    discount_request: [/discount/i, /lower price/i, /best price/i, /bulk/i, /deal/i, /coupon/i, /offer/i, /negotiate/i],
    cancellation:     [/cancel/i, /don.t want/i, /changed my mind/i, /stop.*order/i],
    positive_feedback:[/thank/i, /great (seller|service|product|item)/i, /love (it|this)/i, /perfect/i, /excellent/i, /amazing/i, /happy with/i, /well packed/i, /fast ship/i],
    legal_threat:     [/lawyer/i, /attorney/i, /legal action/i, /sue you/i, /court/i, /trading standards/i, /consumer rights/i, /report you/i, /bbb/i, /complaint/i],
    fraud_claim:      [/scam/i, /fraud/i, /fake/i, /counterfeit/i, /not (genuine|authentic|real)/i, /knock.?off/i, /replica/i],
    off_platform:     [/whatsapp/i, /paypal.*direct/i, /call me/i, /text me/i, /email.*direct/i, /outside.*ebay/i, /off.*ebay/i, /my.*number/i, /phone/i]
  };

  let bestIntent = 'general';
  let bestScore = 0;

  for (const [intent, regexes] of Object.entries(patterns)) {
    let score = 0;
    for (const regex of regexes) {
      if (regex.test(msg)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  // Risk level: high for legal/fraud/off-platform
  const highRisk = ['legal_threat', 'fraud_claim', 'off_platform'].includes(bestIntent);
  const mediumRisk = ['return', 'refund', 'damaged_item', 'cancellation'].includes(bestIntent);

  return {
    intent: bestIntent,
    confidence: Math.min(bestScore * 30 + 20, 95),
    risk: highRisk ? 'high' : mediumRisk ? 'medium' : 'low'
  };
}

// ── Rule-based templates (free, instant, $0 cost) ──────────────────────────
function getRuleBasedReply(intent, sellerName, businessName) {
  const sign = sellerName || businessName || 'The Seller';

  const templates = {
    tracking: `Hi there,\n\nThank you for your message. Your order has been dispatched and is on its way to you. You can find your tracking information in your eBay purchase history or notifications — please allow up to 24 hours for tracking to become active after shipping.\n\nIf you have any other questions, please don't hesitate to ask.\n\nBest regards,\n${sign}`,

    positive_feedback: `Hi,\n\nThank you so much for the kind words — that really means a lot! I'm glad you're happy with your purchase. If you ever need anything in the future, don't hesitate to reach out.\n\nWishing you all the best,\n${sign}`,

    shipping_inquiry: `Hi there,\n\nThank you for your interest! Shipping details including estimated delivery times and costs are listed on each item's listing page. Standard shipping typically takes 3-5 business days domestically.\n\nIf you have any specific questions about shipping to your location, I'm happy to help.\n\nBest regards,\n${sign}`,

    item_question: `Hi,\n\nThank you for your question! All product details, specifications, and compatibility information are listed in the item description. I'd recommend checking there first.\n\nIf you need any clarification or have specific questions not covered in the listing, please let me know and I'll be happy to help.\n\nBest regards,\n${sign}`,

    off_platform: `Hi,\n\nThank you for your message. For the protection of both buyers and sellers, I handle all communication and transactions through eBay's official messaging and checkout system.\n\nPlease feel free to continue our conversation here — I'm happy to help with anything you need.\n\nBest regards,\n${sign}`
  };

  return templates[intent] || null;
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
      model: 'claude-haiku-4-5-20241022',
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
  // Claude Haiku pricing: $0.80/1M input, $4.00/1M output
  const cost = ((usage.input_tokens || 0) * 0.0000008) + ((usage.output_tokens || 0) * 0.000004);

  return {
    reply: data.content[0].text.trim(),
    model: 'claude-haiku-4-5-20241022',
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    cost: parseFloat(cost.toFixed(6))
  };
}

// ── Build system prompt ────────────────────────────────────────────────────
function buildSystemPrompt(user, intent, risk, toneSamples) {
  let prompt = `You are an expert eBay customer service assistant. You write replies on behalf of an eBay seller.

SELLER INFO:
- Business name: ${user.business_name || 'eBay Store'}
- Seller name: ${user.signature_name || user.name || 'The Seller'}
- Preferred tone: ${user.reply_tone || 'professional'}

RULES:
- Be ${user.reply_tone || 'professional'}, helpful, and concise
- Keep replies under 150 words unless the situation is complex
- Never admit fault or liability — stay neutral and helpful
- Never suggest communicating outside of eBay
- Always sign off with the seller's name
- For tracking questions: remind them to check eBay purchase history
- For returns: refer to the store's return policy on the listing
- For damaged items: express concern, ask for photos, offer solutions
- For legal threats: stay calm, neutral, factual — do NOT admit liability
- For fraud claims: politely defend product authenticity, offer to help
- NEVER make up tracking numbers, order details, or product specs
- If you're unsure about specific order details, ask the buyer to provide them`;

  if (risk === 'high') {
    prompt += `\n\n⚠️ HIGH RISK MESSAGE DETECTED (${intent}):
- Be EXTRA careful with your wording
- Do NOT admit fault or accept liability
- Stay factual and professional
- Suggest resolving through eBay's resolution center if needed
- Do not escalate or be defensive`;
  }

  if (toneSamples && toneSamples.length > 0) {
    prompt += `\n\nTONE REFERENCE — Here are examples of how this seller writes. Match their style:\n`;
    toneSamples.slice(0, 3).forEach((sample, i) => {
      prompt += `\nExample ${i + 1}:\n${sample.text.slice(0, 500)}\n`;
    });
  }

  return prompt;
}

// ── POST /reply/generate — main reply generation endpoint ──────────────────
router.post('/generate', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const { customer_message, modify_instructions, buyer_name } = req.body;

    if (!customer_message || customer_message.trim().length < 3) {
      return res.status(400).json({ error: 'Customer message is required' });
    }

    const user = req.user;

    // Step 1: Classify intent
    const { intent, confidence, risk } = classifyIntent(customer_message);

    // Step 2: Get tone samples
    const { data: toneSamples } = await supabase
      .from('tone_samples')
      .select('text')
      .eq('user_id', user.id)
      .limit(3);

    // Step 3: Route to appropriate AI tier
    let reply, model, tokens, cost, route;

    // Tier 1: Rule-based (free) — for simple, high-confidence intents with low risk
    if (confidence >= 80 && risk === 'low' && !modify_instructions) {
      const ruleReply = getRuleBasedReply(intent, user.signature_name || user.name, user.business_name);
      if (ruleReply) {
        reply = ruleReply;
        model = 'rule-based';
        tokens = 0;
        cost = 0;
        route = 'rule';
      }
    }

    // Tier 2: GPT-4o-mini — for medium complexity
    if (!reply && risk !== 'high') {
      try {
        const systemPrompt = buildSystemPrompt(user, intent, risk, toneSamples);
        let userMsg = `Customer message:\n"${customer_message}"`;
        if (buyer_name) userMsg += `\n\nBuyer name: ${buyer_name}`;
        if (modify_instructions) userMsg += `\n\nAdditional instructions from seller: ${modify_instructions}`;

        const result = await callOpenAI(systemPrompt, userMsg);
        reply = result.reply;
        model = result.model;
        tokens = result.tokens;
        cost = result.cost;
        route = 'mini';
      } catch (err) {
        console.error('OpenAI failed, falling back to Anthropic:', err.message);
        // Fall through to Tier 3
      }
    }

    // Tier 3: Claude Haiku — for high-risk or when GPT fails
    if (!reply) {
      try {
        const systemPrompt = buildSystemPrompt(user, intent, risk, toneSamples);
        let userMsg = `Customer message:\n"${customer_message}"`;
        if (buyer_name) userMsg += `\n\nBuyer name: ${buyer_name}`;
        if (modify_instructions) userMsg += `\n\nAdditional instructions from seller: ${modify_instructions}`;

        const result = await callAnthropic(systemPrompt, userMsg);
        reply = result.reply;
        model = result.model;
        tokens = result.tokens;
        cost = result.cost;
        route = 'large';
      } catch (err) {
        console.error('Anthropic also failed:', err.message);
        return res.status(500).json({ error: 'AI service unavailable. Please try again in a moment.' });
      }
    }

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
      customer_message: customer_message.slice(0, 2000),
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
    res.json({
      success: true,
      reply,
      intent,
      risk,
      route,
      latency_ms: latency
    });

  } catch (err) {
    console.error('Reply generation error:', err);
    res.status(500).json({ error: 'Failed to generate reply. Please try again.' });
  }
});

// ── POST /reply/modify — modify an existing reply ──────────────────────────
router.post('/modify', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const { original_reply, customer_message, instructions } = req.body;

    if (!original_reply || !instructions) {
      return res.status(400).json({ error: 'Original reply and instructions are required' });
    }

    const user = req.user;

    const systemPrompt = `You are an expert eBay customer service assistant. A seller has asked you to modify a draft reply.

SELLER INFO:
- Business name: ${user.business_name || 'eBay Store'}
- Seller name: ${user.signature_name || user.name || 'The Seller'}
- Preferred tone: ${user.reply_tone || 'professional'}

RULES:
- Apply the seller's modification instructions to the existing reply
- Keep the same general tone and structure
- Never admit fault or liability
- Never suggest communicating outside of eBay
- Keep it concise unless asked to expand`;

    const userMsg = `Original customer message:\n"${customer_message || 'Not provided'}"\n\nCurrent draft reply:\n"${original_reply}"\n\nSeller's modification instructions:\n"${instructions}"`;

    let result;
    try {
      result = await callOpenAI(systemPrompt, userMsg);
    } catch {
      result = await callAnthropic(systemPrompt, userMsg);
    }

    const latency = Date.now() - startTime;

    res.json({
      success: true,
      reply: result.reply,
      route: 'modify',
      latency_ms: latency
    });

  } catch (err) {
    console.error('Reply modification error:', err);
    res.status(500).json({ error: 'Failed to modify reply. Please try again.' });
  }
});

module.exports = router;
