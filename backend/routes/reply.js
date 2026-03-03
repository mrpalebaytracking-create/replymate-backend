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

// 6) Writer Agent (AI)
let result;
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

const reply = safe.reply;
const model = result.model;
const tokens = result.tokens;
const cost = result.cost;

// Determine route label (for your usage counters)
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

res.json({
  success: true,
  reply,
  intent,
  risk,
  route,
  latency_ms: latency,
  ...(debug ? { agents: { classifier, dataFetch, riskOut, profitOut, reasoning } } : {})
});


  } catch (err) {
    console.error('Reply generation error:', err);
    res.status(500).json({ error: 'Failed to generate reply. Please try again.' });
  }
});

// ── POST /reply/modify — modify an existing reply (IMPROVED) ───────────────
router.post('/modify', requireLicense, async (req, res) => {
  const startTime = Date.now();

  try {
    const { 
      original_reply, 
      customer_message, 
      instructions
    } = req.body;

    if (!original_reply || !instructions) {
      return res.status(400).json({ error: 'Original reply and instructions required' });
    }

    const user = req.user;

    // Build a SIMPLE, CLEAR system prompt
    const systemPrompt = `You are modifying a customer service reply for an eBay seller.

SELLER: ${user.business_name || 'eBay Store'} (${user.signature_name || 'The Seller'})

YOUR TASK: Follow the seller's modification instructions EXACTLY.

RULES:
1. If they say "just say welcome" → Write ONLY "You're welcome!"
2. If they say "make it shorter" → Cut the length by 50%
3. If they say "remove X" → Delete that phrase completely
4. If they say "add X" → Add it naturally
5. If they say "nothing else" → Keep it minimal
6. Always end with seller's name signature

FOLLOW THE INSTRUCTIONS EXACTLY. Don't add extra content.`;

    const userMsg = `ORIGINAL REPLY:
"${original_reply}"

BUYER'S MESSAGE (for context):
"${customer_message}"

SELLER'S INSTRUCTION:
"${instructions}"

Now rewrite the reply following the instruction EXACTLY. 

CRITICAL:
- If instruction says "just" or "only" → Make it VERY short
- If instruction says "nothing else" → Keep it minimal
- Don't add extra politeness unless asked
- Follow the instruction literally

Write the modified reply now.`;

    let result;
    try {
      result = await callOpenAI(systemPrompt, userMsg);
    } catch {
      result = await callAnthropic(systemPrompt, userMsg);
    }

    const latency = Date.now() - startTime;

    // Log the modification
    await supabase.from('reply_log').insert({
      user_id: user.id,
      intent: 'modification',
      route: 'modify',
      model: result.model,
      customer_message: (customer_message || '').slice(0, 2000),
      generated_reply: result.reply.slice(0, 2000),
      modify_instructions: instructions.slice(0, 500),
      latency_ms: latency,
      tokens_used: result.tokens || 0,
      cost_usd: result.cost || 0,
      source: 'extension'
    });

    res.json({
      success: true,
      reply: result.reply,
      route: 'modify',
      model: result.model,
      latency_ms: latency
    });

  } catch (err) {
    console.error('Reply modification error:', err);
    res.status(500).json({ error: 'Failed to modify reply. Please try again.' });
  }
});

module.exports = router;
