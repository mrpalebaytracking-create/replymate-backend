// routes/reply.js — AI Reply Generation (server-side, uses eBay data when available)
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const supabase = require('../db/supabase');

// ── License middleware ─────────────────────────────────────────────────────
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
    return res.status(403).json({ error: 'trial_expired', message: 'Your 14-day trial has ended.' });
  if (user.plan === 'expired')
    return res.status(403).json({ error: 'trial_expired', message: 'Your trial has ended.' });
  if (user.plan !== 'trial' && user.subscription_status === 'canceled' && user.subscription_end && now > new Date(user.subscription_end))
    return res.status(403).json({ error: 'subscription_ended' });

  req.user = user;
  next();
}

// ── Intent classification ──────────────────────────────────────────────────
function classifyIntent(msg) {
  const m = msg.toLowerCase();
  const patterns = {
    tracking:         [/track/i, /where.*(order|package|item)/i, /when.*(arrive|deliver|ship|get)/i, /hasn.t (arrived|shipped)/i, /not received/i],
    return:           [/return/i, /send.*back/i, /return (policy|label)/i, /exchange/i],
    refund:           [/refund/i, /money back/i, /reimburse/i],
    damaged_item:     [/damaged/i, /broken/i, /cracked/i, /defective/i, /not working/i, /doesn.t work/i, /faulty/i],
    shipping_inquiry: [/shipping (cost|time|method)/i, /how long.*(ship|deliver)/i, /free shipping/i],
    item_question:    [/compatible/i, /does (it|this) (work|fit)/i, /what.*(size|color|dimension)/i, /specs/i],
    discount_request: [/discount/i, /lower price/i, /best price/i, /deal/i, /offer/i],
    cancellation:     [/cancel/i, /don.t want/i, /changed my mind/i],
    positive_feedback:[/thank/i, /great (seller|service)/i, /love it/i, /perfect/i, /excellent/i],
    legal_threat:     [/lawyer/i, /legal action/i, /sue/i, /court/i, /report you/i],
    fraud_claim:      [/scam/i, /fraud/i, /fake/i, /counterfeit/i],
    off_platform:     [/whatsapp/i, /call me/i, /text me/i, /outside.*ebay/i]
  };

  let best = 'general', score = 0;
  for (const [intent, regs] of Object.entries(patterns)) {
    let s = 0;
    for (const r of regs) if (r.test(m)) s++;
    if (s > score) { score = s; best = intent; }
  }

  const high = ['legal_threat', 'fraud_claim', 'off_platform'].includes(best);
  const med = ['return', 'refund', 'damaged_item', 'cancellation'].includes(best);
  return { intent: best, confidence: Math.min(score * 30 + 20, 95), risk: high ? 'high' : med ? 'medium' : 'low' };
}

// ── Rule templates (free, instant) ─────────────────────────────────────────
function getRuleReply(intent, sign, biz) {
  const name = sign || biz || 'The Seller';
  const t = {
    tracking: `Hi there,\n\nThank you for your message. Your order has been dispatched and is on its way. You can find tracking info in your eBay purchase history — please allow 24 hours for tracking to activate.\n\nIf you need anything else, just let me know.\n\nBest regards,\n${name}`,
    positive_feedback: `Hi,\n\nThank you so much for the kind words! I'm really glad you're happy with your purchase. If you ever need anything, don't hesitate to reach out.\n\nAll the best,\n${name}`,
    shipping_inquiry: `Hi there,\n\nThank you for your interest! Shipping details and estimated delivery times are listed on each item's page. Standard shipping typically takes 3-5 business days domestically.\n\nLet me know if you have specific questions about shipping to your area.\n\nBest regards,\n${name}`,
    off_platform: `Hi,\n\nThank you for your message. For the protection of both buyers and sellers, I handle all communication and transactions through eBay's messaging system.\n\nPlease continue our conversation here — I'm happy to help!\n\nBest regards,\n${name}`
  };
  return t[intent] || null;
}

// ── OpenAI call ────────────────────────────────────────────────────────────
async function callOpenAI(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI not configured');

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 500, temperature: 0.7 })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const u = d.usage || {};
  return {
    reply: d.choices[0].message.content.trim(),
    model: 'gpt-4o-mini',
    tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    cost: parseFloat((((u.prompt_tokens || 0) * 0.00000015) + ((u.completion_tokens || 0) * 0.0000006)).toFixed(6))
  };
}

// ── Anthropic call ─────────────────────────────────────────────────────────
async function callAnthropic(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic not configured');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20241022', max_tokens: 600, system, messages: [{ role: 'user', content: user }] })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const u = d.usage || {};
  return {
    reply: d.content[0].text.trim(),
    model: 'claude-haiku-4-5-20241022',
    tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    cost: parseFloat((((u.input_tokens || 0) * 0.0000008) + ((u.output_tokens || 0) * 0.000004)).toFixed(6))
  };
}

// ── Build system prompt ────────────────────────────────────────────────────
function buildPrompt(user, intent, risk, tones, ebayData) {
  let p = `You are an expert eBay customer service assistant writing replies for a seller.

SELLER INFO:
- Business: ${user.business_name || 'eBay Store'}
- Name: ${user.signature_name || user.name || 'The Seller'}
- Tone: ${user.reply_tone || 'professional'}

RULES:
- Be ${user.reply_tone || 'professional'}, helpful, concise (under 150 words)
- Never admit fault or liability
- Never suggest communicating outside eBay
- Sign off with seller's name
- NEVER make up tracking numbers or order details — only use real data provided below`;

  if (ebayData) {
    p += `\n\nREAL ORDER DATA (use this in your reply when relevant):`;
    if (ebayData.tracking && ebayData.tracking.length > 0) {
      p += `\nTracking: ${ebayData.tracking.map(t => `${t.carrier} ${t.trackingNumber}`).join(', ')}`;
    }
    if (ebayData.status) p += `\nOrder status: ${ebayData.status}`;
    if (ebayData.items) p += `\nItems: ${ebayData.items.map(i => i.title).join(', ')}`;
    if (ebayData.buyer) p += `\nBuyer: ${ebayData.buyer}`;
    if (ebayData.total) p += `\nOrder total: ${ebayData.total}`;
    if (ebayData.date) p += `\nOrder date: ${new Date(ebayData.date).toLocaleDateString()}`;
  }

  if (risk === 'high') {
    p += `\n\n⚠️ HIGH RISK (${intent}): Be EXTRA careful. Do NOT admit fault. Stay neutral. Suggest eBay resolution center if needed.`;
  }

  if (tones && tones.length > 0) {
    p += `\n\nTONE EXAMPLES (match this style):\n`;
    tones.slice(0, 3).forEach((s, i) => { p += `\n${i + 1}. ${s.text.slice(0, 400)}\n`; });
  }

  return p;
}

// ── POST /reply/generate ───────────────────────────────────────────────────
router.post('/generate', requireLicense, async (req, res) => {
  const t0 = Date.now();
  try {
    const { customer_message, modify_instructions, buyer_name, order_id } = req.body;
    if (!customer_message || customer_message.trim().length < 3)
      return res.status(400).json({ error: 'Customer message is required' });

    const user = req.user;
    const { intent, confidence, risk } = classifyIntent(customer_message);

    // Get tone samples
    const { data: tones } = await supabase.from('tone_samples').select('text').eq('user_id', user.id).limit(3);

    // Try to get eBay order data if connected
    let ebayData = null;
    if (order_id || buyer_name) {
      try {
        const { data: account } = await supabase
          .from('ebay_accounts')
          .select('ebay_token, token_expires_at')
          .eq('user_id', user.id)
          .eq('is_primary', true)
          .single();

        if (account?.ebay_token && (!account.token_expires_at || new Date() < new Date(account.token_expires_at))) {
          let url = 'https://api.ebay.com/sell/fulfillment/v1/order?limit=5';
          if (order_id) url += `&orderIds=${order_id}`;

          const oRes = await fetch(url, { headers: { 'Authorization': `Bearer ${account.ebay_token}` } });
          const oData = await oRes.json();
          let orders = oData.orders || [];

          if (buyer_name && !order_id) {
            const s = buyer_name.toLowerCase();
            orders = orders.filter(o => (o.buyer?.username || '').toLowerCase().includes(s));
          }

          if (orders.length > 0) {
            const o = orders[0];
            ebayData = {
              orderId: o.orderId,
              buyer: o.buyer?.username,
              total: o.pricingSummary?.total?.value,
              status: o.orderFulfillmentStatus,
              date: o.creationDate,
              items: (o.lineItems || []).map(li => ({ title: li.title, sku: li.sku })),
              tracking: []
            };
            // Get tracking
            try {
              const fRes = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${o.orderId}/shipping_fulfillment`, {
                headers: { 'Authorization': `Bearer ${account.ebay_token}` }
              });
              const fData = await fRes.json();
              ebayData.tracking = (fData.fulfillments || []).map(f => ({
                carrier: f.shippingCarrierCode || '',
                trackingNumber: f.trackingNumber || ''
              }));
            } catch {}
          }
        }
      } catch (e) { console.error('eBay data fetch failed:', e.message); }
    }

    // Route: rule → mini → large
    let reply, model, tokens = 0, cost = 0, route;

    if (confidence >= 80 && risk === 'low' && !modify_instructions && !ebayData) {
      const rr = getRuleReply(intent, user.signature_name || user.name, user.business_name);
      if (rr) { reply = rr; model = 'rule'; tokens = 0; cost = 0; route = 'rule'; }
    }

    if (!reply && risk !== 'high') {
      try {
        const sys = buildPrompt(user, intent, risk, tones, ebayData);
        let msg = `Customer message:\n"${customer_message}"`;
        if (buyer_name) msg += `\nBuyer: ${buyer_name}`;
        if (modify_instructions) msg += `\nSeller instructions: ${modify_instructions}`;

        const r = await callOpenAI(sys, msg);
        reply = r.reply; model = r.model; tokens = r.tokens; cost = r.cost; route = 'mini';
      } catch (e) { console.error('OpenAI failed:', e.message); }
    }

    if (!reply) {
      try {
        const sys = buildPrompt(user, intent, risk, tones, ebayData);
        let msg = `Customer message:\n"${customer_message}"`;
        if (buyer_name) msg += `\nBuyer: ${buyer_name}`;
        if (modify_instructions) msg += `\nSeller instructions: ${modify_instructions}`;

        const r = await callAnthropic(sys, msg);
        reply = r.reply; model = r.model; tokens = r.tokens; cost = r.cost; route = 'large';
      } catch (e) {
        console.error('Anthropic failed:', e.message);
        return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
      }
    }

    const latency = Date.now() - t0;

    // Track usage
    const today = new Date().toISOString().split('T')[0];
    const { data: ex } = await supabase.from('usage').select('id, replies_count, rule_count, mini_count, large_count, tokens_used, cost_usd').eq('user_id', user.id).eq('date', today).single();

    if (ex) {
      await supabase.from('usage').update({
        replies_count: ex.replies_count + 1,
        rule_count: ex.rule_count + (route === 'rule' ? 1 : 0),
        mini_count: ex.mini_count + (route === 'mini' ? 1 : 0),
        large_count: ex.large_count + (route === 'large' ? 1 : 0),
        tokens_used: ex.tokens_used + tokens,
        cost_usd: parseFloat(ex.cost_usd) + cost
      }).eq('id', ex.id);
    } else {
      await supabase.from('usage').insert({ user_id: user.id, date: today, replies_count: 1, rule_count: route === 'rule' ? 1 : 0, mini_count: route === 'mini' ? 1 : 0, large_count: route === 'large' ? 1 : 0, tokens_used: tokens, cost_usd: cost });
    }

    await supabase.from('reply_log').insert({ user_id: user.id, intent, route, model, customer_message: customer_message.slice(0, 2000), generated_reply: reply.slice(0, 2000), modify_instructions: modify_instructions || null, latency_ms: latency, tokens_used: tokens, cost_usd: cost, source: 'extension' });
    await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id);

    res.json({ success: true, reply, intent, risk, route, latency_ms: latency, ebay_data_used: !!ebayData });

  } catch (err) {
    console.error('Reply error:', err);
    res.status(500).json({ error: 'Failed to generate reply.' });
  }
});

// ── POST /reply/modify ─────────────────────────────────────────────────────
router.post('/modify', requireLicense, async (req, res) => {
  const { original_reply, customer_message, instructions } = req.body;
  if (!original_reply || !instructions) return res.status(400).json({ error: 'Missing fields' });

  const user = req.user;
  const sys = `You are an eBay customer service assistant. Modify this draft reply as instructed.\nSeller: ${user.signature_name || user.name || 'The Seller'}\nBusiness: ${user.business_name || 'eBay Store'}\nTone: ${user.reply_tone || 'professional'}\nRules: Never admit fault. Never go off-platform. Keep concise.`;
  const msg = `Customer message: "${customer_message || 'N/A'}"\n\nCurrent reply: "${original_reply}"\n\nModify: "${instructions}"`;

  let result;
  try { result = await callOpenAI(sys, msg); } catch { result = await callAnthropic(sys, msg); }

  res.json({ success: true, reply: result.reply, route: 'modify', latency_ms: 0 });
});

module.exports = router;
