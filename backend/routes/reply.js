// routes/reply.js — ReplyMate Pro v8.0
//
// ARCHITECTURE:
//   1. dataFetch + prefRows run in PARALLEL (~0.5s)
//   2. masterAgent — ONE GPT-4o streaming call (classify + risk + reason + write)
//      → first word streams in ~1.2s
//      → full reply in ~5-7s
//
// Total to first word: ~1.5-2s ✅
// No intermediate JSON calls. All intelligence in one system prompt.

const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../db/supabase');

const { masterAgent }    = require('../agents/Masteragent');
const { dataFetchAgent } = require('../agents/dataFetchAgent');

// ── License middleware ────────────────────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });

  const tAuth = Date.now();
  const { data: user } = await supabase
    .from('users')
    .select('id, plan, trial_end, subscription_status, subscription_end, name, business_name, signature_name, reply_tone')
    .eq('license_key', key)
    .single();

  console.log(`[TIMING] requireLicense Supabase: ${Date.now()-tAuth}ms`);
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
// Pure regex — zero AI cost, instant response for simple messages
function quickClassify(msg) {
  const m = msg.toLowerCase();
  if (/\b(thank|thanks|received|arrived|got it|perfect|great|excellent|brilliant|amazing|wonderful)\b/.test(m) &&
      !/\b(but|however|although|except|broken|damaged|wrong|missing|never|still|waiting)\b/.test(m))
    return 'positive_feedback';
  if (/\b(whatsapp|telegram|email me|call me|text me|outside ebay|directly)\b/.test(m))
    return 'off_platform';
  if (msg.length < 120) {
    if (/\b(how long|delivery time|shipping|postage cost|do you ship)\b/.test(m)) return 'shipping_inquiry';
    if (/\b(just paid|payment sent|i've paid|confirm payment)\b/.test(m)) return 'payment_confirmation';
    if (/\b(still available|in stock|have you got|do you have more)\b/.test(m)) return 'availability';
    if (/\b(when will you send|been dispatched|when are you shipping)\b/.test(m)) return 'dispatch_confirmation';
    if (/\b(combine postage|combined shipping|buy multiple|more than one)\b/.test(m)) return 'combined_shipping';
  }
  return null;
}

function runJuniorAgent(user, intent, msg) {
  const sign  = user.signature_name || user.name || 'The Seller';
  const lower = msg.toLowerCase();
  const templates = {
    positive_feedback: () => {
      if (/arrived|received|got it/.test(lower)) return `Glad to hear it arrived safely — enjoy it!\n\nBest regards,\n${sign}`;
      if (/fast|quick|speedy|prompt/.test(lower)) return `Really appreciate that — glad it reached you quickly!\n\nBest regards,\n${sign}`;
      if (/perfect|exactly|as described/.test(lower)) return `That's great to hear! Really glad it's exactly what you were looking for.\n\nBest regards,\n${sign}`;
      if (/great|brilliant|excellent|amazing/.test(lower)) return `Thank you so much — that really means a lot!\n\nBest regards,\n${sign}`;
      return `You're welcome! Really glad everything worked out well.\n\nBest regards,\n${sign}`;
    },
    off_platform: () => `Hi,\n\nThank you for your message. For the protection of both of us, I keep all communication through eBay's official system.\n\nHappy to help with anything you need right here.\n\nBest regards,\n${sign}`,
    shipping_inquiry: () => `Hi,\n\nThanks for your message! Full shipping details and estimated delivery times are listed on each item's page. If you have a specific question about delivery to your location, feel free to ask.\n\nBest regards,\n${sign}`,
    payment_confirmation: () => `Hi,\n\nThank you — payment received! Your order is being processed and I'll get it dispatched as soon as possible. You'll receive a tracking notification from eBay once it's on its way.\n\nBest regards,\n${sign}`,
    availability: () => `Hi,\n\nThanks for your interest! Everything currently available is listed on eBay. If you're after something specific, just ask and I'll see what I can do.\n\nBest regards,\n${sign}`,
    dispatch_confirmation: () => `Hi,\n\nThank you for your message! Your order will be dispatched within our stated handling time and you'll receive a tracking notification from eBay as soon as it's on its way.\n\nBest regards,\n${sign}`,
    combined_shipping: () => `Hi,\n\nAbsolutely — happy to combine postage. Just add everything to your basket and message me requesting a revised total before paying. I'll sort the combined invoice for you.\n\nBest regards,\n${sign}`,
    item_question: () => `Hi,\n\nGreat question! All product details and specifications are listed in the item description — worth checking there first as it covers most queries.\n\nIf you can't find what you need, just let me know.\n\nBest regards,\n${sign}`,
  };
  if (!templates[intent]) return null;
  return templates[intent]();
}

// ── POST /reply/generate — v8.0 master agent pipeline ────────────────────
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

    const user = req.user;

    // ── Junior Agent: pure regex, zero latency ────────────────────────────
    // Complex signal check — bail on junior if message has ANY complexity
    const complexitySignals = /\b(already|still|yet|weeks?|days?|supposed to|should have|tried|before|again|chased|previous|last time|still waiting|still haven't|broken|damaged|wrong|missing|refund|return|cancel|case|claim|lawyer|trading standards)\b/i;
    const hasComplexity = complexitySignals.test(latestBuyerMessage);

    if (!hasComplexity) {
      const quickIntent = quickClassify(latestBuyerMessage);
      if (quickIntent) {
        const reply = runJuniorAgent(user, quickIntent, latestBuyerMessage);
        if (reply) {
          const latency = Date.now() - startTime;
          logReply(user.id, quickIntent, 'rule', 'rule', latestBuyerMessage, reply, latency, 0, 0).catch(() => {});
          supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id).then(() => {});
          return res.json({
            success: true, reply, intent: quickIntent, risk: 'low', route: 'rule', latency_ms: latency,
            why: {
              agent: { name: 'Junior Agent', icon: '📋' },
              paragraph: `${quickIntent.replace(/_/g, ' ')} — handled instantly with a personalised template.`,
              structured: {
                risk: { level: 'low', label: 'Low Risk', score: 1 },
                constraints: [], ebayStatus: null, sendConfidence: 95,
                humanReview: false, conflictResolutions: []
              }
            }
          });
        }
      }
    }

    // ── PARALLEL: dataFetch + seller prefs ───────────────────────────────
    const t0 = Date.now();
    console.log(`[TIMING] request start → parallel fetch`);
    const [dataFetch, prefRows] = await Promise.all([
      dataFetchAgent({ userId: user.id, needs: { order: true }, orderId: order_id || null }),
      supabase.from('seller_preferences')
        .select('insight')
        .eq('user_id', user.id)
        .order('times_seen', { ascending: false })
        .limit(5)
        .then(r => (r.data || []).map(p => p.insight))
        .catch(() => [])
    ]);
    console.log(`[TIMING] parallel fetch done: ${Date.now()-t0}ms | orderId=${order_id||'none'} | ebay_connected=${dataFetch?.trace?.ebay_connected}`);

    // ── SSE headers — open stream immediately ─────────────────────────────
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    console.log(`[TIMING] SSE headers flushed: ${Date.now()-t0}ms`);

    const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // ── masterAgent — ONE streaming call ─────────────────────────────────
    const tMaster = Date.now();
    let result;
    try {
      result = await masterAgent({
        latestBuyerMessage,
        threadMessages,
        productTitle:       product_title       || '',
        productDescription: product_description || '',
        orderId:            order_id            || null,
        isPrePurchase:      is_pre_purchase     || false,
        dataFetch,
        user,
        sellerPrefs: prefRows,
        onChunk: (text) => sendEvent({ type: 'chunk', text })
      });
      console.log(`[TIMING] masterAgent done: ${Date.now()-tMaster}ms`);
    } catch (err) {
      console.error('[reply] masterAgent failed:', err.message);
      sendEvent({ type: 'error', message: 'AI service unavailable. Please try again.' });
      res.end();
      return;
    }

    const latency = Date.now() - startTime;
    const route   = result.why?.structured?.risk?.score >= 7 ? 'large' : 'mini';

    sendEvent({
      type:       'done',
      reply:      result.reply,
      intent:     result.intent,
      risk:       result.risk,
      route,
      latency_ms: latency,
      why:        result.why
    });

    res.end();

    // Fire-and-forget
    trackUsage(user.id, route, result.tokens, result.cost).catch(() => {});
    logReply(user.id, result.intent, route, 'gpt-4o', latestBuyerMessage, result.reply, latency, result.tokens, result.cost).catch(() => {});
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
      rule_count:  existing.rule_count  + (route === 'rule'  ? 1 : 0),
      mini_count:  existing.mini_count  + (route === 'mini'  ? 1 : 0),
      large_count: existing.large_count + (route === 'large' ? 1 : 0),
      tokens_used: existing.tokens_used + (tokens || 0),
      cost_usd:    parseFloat(existing.cost_usd) + (cost || 0)
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
    const { customer_message, conversation_history, instructions } = req.body;
    if (!instructions?.trim()) return res.status(400).json({ error: 'Instructions are required' });
    if (!Array.isArray(conversation_history) || conversation_history.length < 2)
      return res.status(400).json({ error: 'Conversation history required' });

    const user = req.user;
    const sign = user.signature_name || user.name || 'The Seller';
    const biz  = user.business_name  || 'the store';

    const systemPrompt = `You are the reply assistant for ${biz}. Write AS ${sign}.\nRULES: Never suggest off-eBay contact. Never admit fault. End with "Best regards,\n${sign}".\nOUTPUT THE REPLY ONLY — no preamble, no explanation.`;
    const messages     = [...conversation_history, { role: 'user', content: `My instruction: ${instructions.trim()}` }];
    const apiKey       = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, ...messages], max_tokens: 600, temperature: 0.5 })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message || 'OpenAI error');

    const modifiedReply = aiData.choices[0].message.content.trim();
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
  const prompt = `An eBay seller modified a reply: "${instruction}"\nResulting reply: "${reply.slice(0, 400)}"\nReturn ONLY JSON: {"category":"tone|length|content|policy|greeting|closing","insight":"one clear sentence","applies_to_intent":"${intent}|null"}\nIf too vague: {"skip":true}`;
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
    const prompt = `Analyse this eBay reply.\nBUYER: "${(buyer_message).slice(0, 500)}"\nREPLY: "${(generated_reply).slice(0, 600)}"\nReturn ONLY JSON:\n{"agent":{"name":"Senior Agent","icon":"🏆"},"paragraph":"one sentence on strategy","structured":{"risk":{"level":"low|medium|high","label":"Low Risk|Medium Risk|High Risk"},"constraints":["2-3 short bullets"],"ebayStatus":{"type":"good|warn|missing","text":"status line","showConnect":false}}}`;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 250, temperature: 0.3 })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    let why;
    try { why = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); }
    catch { return res.status(500).json({ error: 'parse failed' }); }
    res.json({ success: true, why });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate why data' });
  }
});

module.exports = router;
