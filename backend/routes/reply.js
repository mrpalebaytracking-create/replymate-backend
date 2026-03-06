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
// Reads agent traces to produce a SPECIFIC, factual explanation of what happened.
// Every sentence refers to real data found — never a generic fallback.
function buildWhyData({ intent, route, risk, classifier, dataFetch, reasoning, latency, latestBuyerMessage, productTitle }) {

  // ── Agent identity ─────────────────────────────────────────────────────
  const agents = {
    rule:  { name: 'Junior Agent',    icon: '📋' },
    mini:  { name: 'Senior Agent',    icon: '✍️'  },
    large: { name: 'Risk Specialist', icon: '🛡️' }
  };
  const agent = agents[route] || agents.mini;

  // ── Pull traces from each agent ────────────────────────────────────────
  const ct = classifier.trace  || {};   // classifier trace
  const dt = dataFetch.trace   || {};   // data fetch trace
  const rt = reasoning.trace   || {};   // reasoning trace

  const ebayConnected = dt.ebay_connected || !dataFetch.missing.includes('ebay_oauth');
  const hasOrderData  = !!(dataFetch.fetched && dataFetch.fetched.order);
  const hasTracking   = !!(dt.tracking_found);
  const productTitle_ = rt.product_title || productTitle || null;

  // ── Build the specific paragraph ──────────────────────────────────────
  let paragraph = '';
  const parts   = []; // sentence fragments assembled into paragraph

  // ── JUNIOR AGENT ──────────────────────────────────────────────────────
  if (route === 'rule') {
    if (intent === 'positive_feedback') {
      const msg = (latestBuyerMessage || '').trim().toLowerCase();
      if (/^(fine|alright|ok|okay|sure|noted|understood|all good)[\s!.]*$/i.test(msg))
        paragraph = "Your buyer sent a brief acknowledgement — nothing to answer, just needs a clean close. I handled it instantly with a short, warm sign-off that leaves the door open without over-explaining.";
      else if (/pleasure|my pleasure/i.test(msg))
        paragraph = "Your buyer is wrapping up politely. I matched their tone — short and warm. Over-responding to a polite close feels awkward, so I kept it proportionate.";
      else if (/thank/i.test(msg))
        paragraph = "Your buyer said thanks. I kept the reply short on purpose — a long response to a simple thank-you can feel pushy or scripted. Clean, genuine, done.";
      else if (/great|brilliant|excellent|amazing|wonderful|fantastic|perfect/i.test(msg))
        paragraph = "Your buyer left positive feedback. I replied briefly and warmly — enough to acknowledge it without sounding robotic. Short positive exchanges like this build your seller reputation.";
      else
        paragraph = "Your buyer sent a short, positive message. I matched their energy — brief and warm. No question to answer, so no need for a long reply.";

    } else if (intent === 'off_platform') {
      paragraph = "Your buyer tried to move the conversation off eBay. I declined politely but firmly. Communicating or transacting outside eBay removes your seller protection entirely — if a dispute arises, eBay won't be able to step in.";

    } else if (intent === 'shipping_inquiry') {
      paragraph = `Your buyer asked about shipping${productTitle_ ? ` for the ${productTitle_}` : ''}. I answered with a safe, consistent template — no delivery promises beyond what your listing already states. Delivery promises are the most common source of negative feedback when things run late.`;

    } else if (intent === 'item_question') {
      const decisions = rt.decisions || [];
      const inTitleDecision = decisions.find(d => d.includes('title confirms'));
      const inDescDecision  = decisions.find(d => d.includes('description also mentions'));
      const descAvailable   = rt.description_available;

      if (inTitleDecision && inDescDecision && productTitle_)
        paragraph = `Your buyer asked about product specifications. I checked both your listing title and description for "${productTitle_}". ${inTitleDecision.charAt(0).toUpperCase() + inTitleDecision.slice(1)}, and the description also confirms additional details. The reply is fully backed by your listing content.`;
      else if (inTitleDecision && productTitle_)
        paragraph = `Your buyer asked about product specifications. The answer was clearly stated in your listing title — "${productTitle_}". ${descAvailable ? 'I also scanned the description for consistency.' : ''} Safe to confirm directly to your buyer.`;
      else if (productTitle_)
        paragraph = `Your buyer asked a product question about the ${productTitle_}. I pointed them to your full listing${descAvailable ? ' (title and description)' : ''} — avoids committing to specs you don't have in front of you.`;
      else
        paragraph = "Your buyer asked a product question. I pointed them to the listing for exact specs — avoids committing to details you might not have at hand.";

    } else {
      paragraph = "This was a routine message that matched a proven reply template. I handled it instantly — professional, accurate, and no AI needed.";
    }

  // ── RISK SPECIALIST ───────────────────────────────────────────────────
  } else if (route === 'large') {
    const flags = (classifier.trace?.signals || []).join('; ');

    if (intent === 'legal_threat')
      paragraph = `I detected legal language in this message (${flags || 'threat keywords found'}). Your Risk Specialist took over immediately. The reply is deliberately neutral — it doesn't agree, argue, or put anything in writing that could be used against you. I directed your buyer to eBay's Resolution Centre: that shows good faith, keeps everything documented, and keeps your seller protection intact.`;
    else if (intent === 'fraud_claim')
      paragraph = `Your buyer is making an authenticity or wrong-item claim (${flags || 'fraud keywords detected'}). Your Risk Specialist handled this. The reply opens a path to resolution without admitting anything or getting defensive — the exact tone that prevents these from escalating into formal eBay disputes.`;
    else if (intent === 'off_platform')
      paragraph = `Your buyer attempted to move this conversation off eBay (${flags || 'off-platform keywords detected'}). Your Risk Specialist flagged it immediately. Communicating outside eBay removes your seller protection entirely. The reply declines politely without making your buyer feel accused.`;
    else
      paragraph = `Your Risk Specialist handled this message (${flags || 'high-risk signals detected'}). The reply is precise — every word chosen to protect you. No fault admitted, no promises made, no escalation.`;

  // ── SENIOR AGENT ──────────────────────────────────────────────────────
  } else {

    if (intent === 'tracking') {
      if (dt.delivery_status === 'delivered') {
        parts.push(`Your buyer says they haven't received their order, but the tracking shows it was already delivered`);
        if (dt.tracking_carrier) parts.push(`by ${dt.tracking_carrier}${dt.tracking_number ? ' (' + dt.tracking_number + ')' : ''}`);
        if (rt.latest_tracking_event) parts.push(`— latest update: "${rt.latest_tracking_event}"`);
        parts.push(`. I asked your buyer to check with neighbours or a safe place before we take any further action.`);

      } else if (dt.delivery_status === 'out_for_delivery') {
        parts.push(`Your buyer is asking for an update. I checked the tracking`);
        if (dt.tracking_carrier) parts.push(` with ${dt.tracking_carrier}`);
        parts.push(` and the parcel is out for delivery today. I informed your buyer delivery is imminent — no action needed on your side right now.`);

      } else if (dt.delivery_status === 'returned') {
        parts.push(`Your buyer hasn't received their order. I checked the tracking and it shows the parcel was returned to sender`);
        if (rt.latest_tracking_event) parts.push(` — last event: "${rt.latest_tracking_event}"`);
        parts.push(`. I raised this as an issue to investigate with the courier and assured your buyer we're looking into it.`);

      } else if (dt.delivery_status === 'in_transit' && dt.estimated_delivery && !dt.is_overdue) {
        parts.push(`Your buyer hasn't received their order yet. I checked the tracking`);
        if (dt.tracking_carrier) parts.push(` (${dt.tracking_carrier}${dt.tracking_number ? ' · ' + dt.tracking_number : ''})`);
        parts.push(` — the parcel is in transit and the estimated delivery date is ${dt.estimated_delivery}, which hasn't passed yet. I asked your buyer to wait until that date before we take any action. No promises were made beyond what the tracking already shows.`);

      } else if (dt.delivery_status === 'in_transit' && dt.is_overdue) {
        parts.push(`Your buyer hasn't received their order. I checked the tracking`);
        if (dt.tracking_carrier) parts.push(` (${dt.tracking_carrier})`);
        parts.push(` — the estimated delivery date of ${dt.estimated_delivery} has now passed. I acknowledged the delay and told your buyer we're raising it with the courier. I was careful not to promise a refund or replacement at this stage.`);

      } else if (!ebayConnected) {
        parts.push(`Your buyer asked about their order. Since your eBay account isn't connected, I couldn't pull live tracking data. I wrote a helpful reply and directed your buyer to their eBay order notifications.`);
        parts.push(` Connect your eBay account and I'll include the real tracking number automatically next time.`);

      } else if (!dt.order_found) {
        parts.push(`Your buyer asked about their order. I checked your eBay account but couldn't match a specific order — no order ID was found in the conversation. I asked your buyer to check their eBay notifications and to share their order number so I can pull the live details.`);

      } else {
        parts.push(`Your buyer asked about their order. I checked your eBay data and wrote a careful reply. No delivery promises were made and I directed your buyer to the right place to track their order.`);
      }
      paragraph = parts.join('');

    } else if (intent === 'damaged_item') {
      paragraph = `Your buyer says their item arrived damaged. Before doing anything else, I asked for photos. That's critical — documented evidence protects you if this goes to a dispute. No fault has been admitted and no refund or replacement has been promised. Once you have photos, you'll be in a much stronger position to decide what to offer.`;

    } else if (intent === 'return') {
      paragraph = `Your buyer wants to return the item${productTitle_ ? ` (${productTitle_})` : ''}. I acknowledged the request but didn't agree to a refund upfront — instead I guided them through eBay's official return process. That protects you: no liability accepted, everything on-platform, and no money moves until you receive the item back.`;

    } else if (intent === 'refund') {
      paragraph = `Your buyer is asking for a refund. I didn't commit to anything — I directed them through eBay's resolution process instead. That's the right route: it creates an audit trail, keeps everything documented, and protects both parties. The word "refund" wasn't used as a promise.`;

    } else if (intent === 'cancellation') {
      const cancelDecision = (rt.decisions || []).find(d => d.includes('cancel') || d.includes('dispatch'));
      if (cancelDecision)
        paragraph = `Your buyer wants to cancel their order. I checked the order status — ${cancelDecision}. The reply handles this appropriately without being dismissive.`;
      else
        paragraph = `Your buyer wants to cancel their order. I replied carefully — keeping your options open without dismissing the request. If the order is already dispatched, your buyer is guided toward the return process instead.`;

    } else if (intent === 'discount_request') {
      paragraph = `Your buyer is trying to negotiate on price${productTitle_ ? ` for the ${productTitle_}` : ''}. I declined politely without being dismissive — your buyer feels heard but the answer is no. I didn't offer any partial discount or create a precedent.`;

    } else if (intent === 'shipping_inquiry') {
      paragraph = `Your buyer asked about shipping${productTitle_ ? ` for the ${productTitle_}` : ''}. I gave a clear, helpful answer without making delivery promises beyond what your listing already states. Vague delivery commitments are the most common cause of negative feedback when things run late.`;

    } else if (intent === 'item_question') {
      const decisions = rt.decisions || [];
      const inTitleDecision  = decisions.find(d => d.includes('title confirms'));
      const inDescDecision   = decisions.find(d => d.includes('description also mentions'));
      const notFoundDecision = decisions.find(d => d.includes('neither title nor description'));
      const descAvailable    = rt.description_available;

      if (inTitleDecision && inDescDecision && productTitle_) {
        paragraph = `Your buyer asked about product specifications. I checked both your listing title and description for "${productTitle_}". ${inTitleDecision.charAt(0).toUpperCase() + inTitleDecision.slice(1)}, and the description also confirms: ${inDescDecision.replace('listing description also mentions: ', '')}. I cross-referenced both sources before answering — the reply is fully backed by your listing.`;
      } else if (inTitleDecision && productTitle_) {
        paragraph = `Your buyer asked about product specifications. I checked your listing title — "${productTitle_}" — which ${inTitleDecision}. ${descAvailable ? 'I also checked the listing description, which is consistent.' : ''} The reply confirms this directly from your listing.`;
      } else if (inDescDecision && productTitle_) {
        paragraph = `Your buyer asked a spec question about the ${productTitle_}. The title doesn't explicitly mention this, but I found it confirmed in your listing description: ${inDescDecision.replace('listing description also mentions: ', '')}. The reply uses your description as the source.`;
      } else if (notFoundDecision && productTitle_) {
        paragraph = `Your buyer asked a spec question about the ${productTitle_}. I checked both the listing title and description but couldn't find a clear answer. Rather than guessing, I pointed your buyer to the full listing — avoids committing to details not clearly stated.`;
      } else if (productTitle_) {
        paragraph = `Your buyer asked a product question about the ${productTitle_}. I checked your listing${descAvailable ? ' title and description' : ' title'} and answered based on what's stated there.`;
      } else {
        paragraph = `Your buyer asked a product question. I answered based on the available listing information and pointed them to the full listing for complete specs.`;
      }

    } else {
      // General — use message signals from classifier trace
      const msgLen   = (latestBuyerMessage || '').trim().length;
      const msgLower = (latestBuyerMessage || '').toLowerCase();
      const signal   = ct.signals?.[0] || '';

      if (msgLen <= 15)
        paragraph = `Your buyer sent a short message ("${latestBuyerMessage?.trim()}"). I kept the reply proportionate — brief and warm. A long response to a short message feels off, so I matched their energy.`;
      else if (msgLower.includes('sorry') || msgLower.includes('apologis') || msgLower.includes('my fault'))
        paragraph = `Your buyer is apologising or acknowledging something. I replied warmly without over-reassuring or making commitments. The tone keeps the relationship positive while keeping you covered.`;
      else if (msgLower.includes('wait') || msgLower.includes('patient') || msgLower.includes('understand'))
        paragraph = `Your buyer is showing patience. I replied warmly to reinforce that goodwill — short, appreciative, and no promises made.`;
      else if (msgLen > 200)
        paragraph = `Your buyer sent a detailed message. I focused on the main concern without getting drawn into side points — covering what matters, avoiding anything that could create liability.`;
      else if (signal)
        paragraph = `I detected: ${signal}. I wrote a professional, focused reply that addresses the concern without creating liability, making promises, or suggesting off-platform communication.`;
      else
        paragraph = `I reviewed your buyer's message carefully and wrote a professional reply. Nothing in it creates liability, makes promises, or suggests off-platform communication.`;
    }
  }

  // ── Structured data ────────────────────────────────────────────────────
  const riskLabels = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' };
  const constraints = (reasoning.constraints || []).slice(0, 4);

  // eBay data status line
  let ebayStatus = null;
  if (hasTracking && dt.tracking_number) {
    ebayStatus = { type: 'good', text: `Live tracking checked: ${dt.tracking_carrier ? dt.tracking_carrier + ' · ' : ''}${dt.tracking_number}` };
  } else if (hasOrderData) {
    ebayStatus = { type: 'good', text: 'Live eBay order data used' };
  } else if (ebayConnected && ['tracking','return','refund','damaged_item','cancellation'].includes(intent)) {
    ebayStatus = { type: 'warn', text: 'eBay connected but no order ID found in this conversation' };
  } else if (!ebayConnected && ['tracking','return','refund','damaged_item','cancellation'].includes(intent)) {
    ebayStatus = { type: 'missing', text: 'eBay not connected — reply written without live order data', showConnect: true };
  }

  return {
    agent,
    paragraph,
    structured: {
      risk:       { level: risk, label: riskLabels[risk] || 'Low Risk' },
      constraints,
      ebayStatus,
      latency_ms: latency
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
  order_id,
  product_title,
  product_description
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
  profit: profitOut,
  productTitle:       product_title || '',
  productDescription: product_description || ''
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
    const why = buildWhyData({ intent, route, risk, classifier, dataFetch, reasoning, latency, latestBuyerMessage, productTitle: product_title || '', productDescription: product_description || '' });

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

// ── Strips conversational preamble from AI replies ────────────────────────
// GPT sometimes prefixes replies with "Here's a revised version:" etc.
// This function removes that and returns only the actual reply text.
function stripPreamble(text) {
  if (!text) return text;
  // Patterns that indicate a preamble line
  const preamblePatterns = [
    /^(here'?s?|sure[,!]?|of course[,!]?|certainly[,!]?|absolutely[,!]?).{0,80}:\s*/i,
    /^(i'?ve?|i have).{0,60}:\s*/i,
    /^(below is|here is|here are|the (updated|revised|modified|new) (reply|message|version)).{0,60}:\s*/i,
    /^(updated|revised|modified) (reply|message|version)[:\s]+/i,
  ];

  for (const pat of preamblePatterns) {
    const cleaned = text.replace(pat, '').trim();
    // Only strip if what remains still looks like a real reply (has some length)
    if (cleaned.length > 20 && cleaned !== text) return cleaned;
  }

  // Also handle: first line ends with colon and is short (< 80 chars) — classic preamble
  const lines = text.split('\n');
  if (lines.length > 1 && lines[0].trim().endsWith(':') && lines[0].trim().length < 100) {
    const rest = lines.slice(1).join('\n').trim();
    if (rest.length > 20) return rest;
  }

  return text;
}

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
7. OUTPUT THE REPLY ONLY — no preamble, no "Here's the revised reply:", no explanation before or after. Just the reply itself, ready to send.

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

    const rawReply = aiData.choices[0].message.content.trim();

    // Strip any conversational preamble GPT adds before the actual reply.
    // e.g. "Here's a revised reply:" / "Sure! Here is the updated version:" etc.
    // We detect these by looking for a colon-terminated intro sentence, then take what follows.
    const modifiedReply = stripPreamble(rawReply);
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
