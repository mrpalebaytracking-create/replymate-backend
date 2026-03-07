// agents/masterAgent.js — ReplyMate Pro v8.0
//
// ONE GPT-4o streaming call that does everything:
//   - Classifies intent + risk + manipulation
//   - Assesses financial/legal risk
//   - Builds strategy
//   - WRITES the reply
//
// Streams reply tokens directly to the client via onChunk callback.
// At end of stream, returns structured metadata for the Why panel.
//
// WHY ONE CALL:
//   3 x gpt-4o-mini JSON calls = ~6s + ~7s + 1s = 14s to first word
//   1 x gpt-4o stream          = ~1.2s to first word
//   Intelligence preserved via system prompt — model reasons internally

const fetch = require('node-fetch');

// ── Extract seller voice from thread ──────────────────────────────────────
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
  const signoffs = msgs.map(m => m.match(/(Kind regards|Best regards|Many thanks|Thanks|Cheers|Take care)[,\s\n]+\w*/i)?.[0]).filter(Boolean);
  if (signoffs.length) traits.push(`Signs off: "${signoffs[0]}"`);
  const avgLen = msgs.reduce((s, m) => s + m.length, 0) / msgs.length;
  if (avgLen < 80)        traits.push('Writes SHORT punchy messages');
  else if (avgLen > 280)  traits.push('Writes DETAILED thorough messages');
  else                    traits.push('Writes moderate-length messages');
  if (msgs.some(m => /\b(gonna|wanna|yeah|cheers|yep)\b/i.test(m))) traits.push('Casual friendly tone');
  if (msgs.some(m => /\b(I'll|we'll|I'm|it's|don't|can't)\b/.test(m))) traits.push('Uses natural contractions');
  const prevOpenings = msgs.map(m => m.split('\n')[0].trim()).filter(Boolean).slice(-3);
  return { traits, prevOpenings };
}

async function masterAgent({
  latestBuyerMessage,
  threadMessages,
  productTitle,
  productDescription,
  orderId,
  isPrePurchase,
  dataFetch,
  user,
  sellerPrefs,
  onChunk   // callback(text) called for each streamed token
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const sign     = user.signature_name || user.name || 'The Seller';
  const biz      = user.business_name  || 'eBay Store';
  const tone     = user.reply_tone     || 'professional';
  const voice    = extractSellerVoice(threadMessages);
  const dt       = dataFetch?.trace || {};
  const order    = dataFetch?.fetched?.order;

  // Build data facts block
  const facts = [];
  if (order) {
    facts.push(`Order ${order.orderId} | Status: ${order.status}`);
    if (order.items?.length) facts.push(`Items: ${order.items.map(i => `${i.qty}× ${i.title}`).join('; ')}`);
  }
  if (dt.tracking_found) {
    facts.push(`Tracking: ${[dt.tracking_carrier, dt.tracking_number].filter(Boolean).join(' ')}`);
    facts.push(`Delivery: ${dt.delivery_status}${dt.is_overdue ? ' — OVERDUE' : ''}`);
    if (dt.estimated_delivery) facts.push(`Est. delivery: ${dt.estimated_delivery}`);
  }
  if (!dt.ebay_connected) facts.push('⚠ eBay not connected — no live order data');
  if (productTitle) facts.push(`Product: ${productTitle}`);

  // Seller prefs block
  const prefsBlock = sellerPrefs?.length
    ? `\nSELLER LEARNED PREFERENCES (apply these):\n${sellerPrefs.map(p => `• ${p}`).join('\n')}`
    : '';

  // Voice block
  const voiceBlock = voice?.traits?.length
    ? `\nSELLER WRITING VOICE — mirror exactly:\n${voice.traits.map(t => `• ${t}`).join('\n')}`
    : '';

  // Previous openings to avoid
  const prevOpenBlock = voice?.prevOpenings?.length
    ? `\nDO NOT start with these (already used):\n${voice.prevOpenings.map(o => `• "${o}"`).join('\n')}`
    : '';

  // Thread context (last 8 messages)
  const threadBlock = Array.isArray(threadMessages) && threadMessages.length
    ? threadMessages.slice(-8).map(m => `${m.role.toUpperCase()}: ${(m.text || '').trim()}`).join('\n')
    : '(first message)';

  // Pre-purchase hard constraints
  const prePurchaseBlock = isPrePurchase
    ? '\n⚠ PRE-PURCHASE ENQUIRY: Buyer has NOT ordered. NEVER mention orders, tracking, dispatch times, or feedback.'
    : '';

  const SYSTEM = `You are a senior eBay customer service expert writing replies for ${biz}.
You write AS ${sign} — you ARE this person.
Preferred tone: ${tone}
${voiceBlock}
${prefsBlock}

━━━ YOUR TASK ━━━
Read the buyer's message carefully. Then write the perfect reply.
Think through: What does the buyer actually want? What's the risk? What's the smart move?
Then write the reply directly — no preamble, no "Here's the reply:", just write it.

━━━ INTENT AWARENESS ━━━
Detect: tracking / damaged_item / return / refund / cancellation / legal_threat / fraud_claim /
        off_platform / discount_request / shipping_inquiry / item_question / positive_feedback /
        dispatch_confirmation / payment_confirmation / availability / general

━━━ RISK RULES ━━━
• Legal threat (solicitor/Trading Standards/sue/court): de-escalate, do NOT admit fault, offer Resolution Centre
• Manipulation (emotional leverage, threats): stay professional, do not be pressured
• Damaged/not received: ask for photo evidence before committing to resolution
• Refund demand: reference eBay Money Back Guarantee process, do not promise outside it
• Off-platform requests: politely refuse, keep on eBay
• NEVER: admit fault/liability, suggest off-eBay contact, invent tracking details, make promises you can't keep

━━━ HUMAN TOUCH RULES ━━━
1. Acknowledge the emotion FIRST — "Sorry to hear that" before any solution
2. Reference something specific — item name, carrier, wait time — never generic
3. Time-anchor naturally — "I've just checked", "I'm looking at this now"
4. Use contractions — I'll, it's, we're — sound human not robotic
5. Mirror buyer's formality — casual buyer → more casual; formal → stay measured
6. ONE genuine interest signal — "Hope it arrives in time for your plans"
7. Vary sign-off to match warmth — not always "Best regards"
${prevOpenBlock}

━━━ ABSOLUTE RULES ━━━
• Never suggest WhatsApp, email, phone, or any off-eBay contact
• Never admit fault or liability
• Never invent order details, tracking numbers, or delivery dates
• Always end with: ${sign}
• Output the reply ONLY — no metadata, no explanation

━━━ AFTER THE REPLY ━━━
On a new line after the reply, output exactly this JSON (one line):
|||{"intent":"<primary intent>","risk":"<low|medium|high>","riskScore":<1-10>,"strategy":"<one sentence — why this approach>","manipulation":<true|false>}|||`;

  const USER = `BUYER'S MESSAGE:
"${latestBuyerMessage}"

CONVERSATION HISTORY:
${threadBlock}

LIVE DATA:
${facts.length ? facts.map(f => `• ${f}`).join('\n') : '• No eBay data available'}
${prePurchaseBlock}`;

  // ── Streaming call ────────────────────────────────────────────────────────
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       'gpt-4o',
      messages:    [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }],
      max_tokens:  600,
      temperature: 0.7,
      stream:      true,
      stream_options: { include_usage: true }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err.slice(0, 200)}`);
  }

  let fullText    = '';
  let buffer      = '';
  let inputTok    = 0;
  let outputTok   = 0;
  let replyPart   = '';
  let metaPart    = '';
  let splitFound  = false;
  let firstChunk  = true;
  let preambleBuf = '';

  // Preamble patterns to strip
  const PREAMBLE = /^(here'?s?|sure[,!]?|of course[,!]?|certainly[,!]?|absolutely[,!]?|i'?ve?|i have|below is|here is).{0,80}[:\n]\s*/i;

  await new Promise((resolve, reject) => {
    response.body.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') { if (trimmed === 'data: [DONE]') resolve(); continue; }
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json  = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content || '';
          if (json.usage) { inputTok = json.usage.prompt_tokens || 0; outputTok = json.usage.completion_tokens || 0; }
          if (!delta) continue;

          fullText += delta;

          // Detect the ||| metadata separator
          if (!splitFound && fullText.includes('|||')) {
            const sepIdx = fullText.indexOf('|||');
            replyPart  = fullText.slice(0, sepIdx).trim();
            splitFound = true;
            // Don't stream the metadata part
            continue;
          }
          if (splitFound) {
            metaPart += delta; // accumulate metadata after |||
            continue;
          }

          // Stream reply tokens with preamble stripping
          if (firstChunk) {
            preambleBuf += delta;
            if (preambleBuf.length >= 80) {
              const cleaned = preambleBuf.replace(PREAMBLE, '').trim();
              if (onChunk && cleaned) onChunk(cleaned);
              preambleBuf = '';
              firstChunk  = false;
            }
          } else {
            if (onChunk) onChunk(delta);
          }
        } catch { /* skip malformed */ }
      }
    });
    response.body.on('end', resolve);
    response.body.on('error', reject);
  });

  // Flush any remaining preamble buffer (short replies)
  if (firstChunk && preambleBuf) {
    const cleaned = preambleBuf.replace(PREAMBLE, '').trim();
    if (onChunk && cleaned) onChunk(cleaned);
  }

  // Final reply = everything before ||| separator (or full text if no separator)
  if (!splitFound) replyPart = fullText.trim();

  // Strip preamble from full accumulated reply
  replyPart = replyPart.replace(PREAMBLE, '').trim();

  // Parse metadata
  let meta = { intent: 'general', risk: 'low', riskScore: 3, strategy: '', manipulation: false };
  try {
    const metaStr = (metaPart + fullText).match(/\|\|\|({[^}]+})\|\|\|/)?.[1];
    if (metaStr) meta = { ...meta, ...JSON.parse(metaStr) };
  } catch { /* use defaults */ }

  // Build eBay status for Why panel
  let ebayStatus = null;
  if (dt.tracking_found && dt.tracking_number) {
    ebayStatus = { type: 'good', text: `Tracking checked: ${dt.tracking_carrier ? dt.tracking_carrier + ' · ' : ''}${dt.tracking_number}` };
  } else if (dt.order_found) {
    ebayStatus = { type: 'good', text: 'Live eBay order data used' };
  } else if (!dt.ebay_connected) {
    ebayStatus = { type: 'missing', text: 'eBay not connected — no live order data', showConnect: true };
  }

  const cost = (inputTok * 0.0000025) + (outputTok * 0.00001);

  return {
    reply:  replyPart,
    intent: meta.intent,
    risk:   meta.risk,
    why: {
      agent:     { name: 'Senior Agent', icon: '✍️' },
      paragraph: meta.strategy || 'Reply generated from buyer message and available context.',
      structured: {
        risk:        { level: meta.risk, label: { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' }[meta.risk] || 'Low Risk', score: meta.riskScore },
        constraints: sellerPrefs?.slice(0, 3) || [],
        ebayStatus,
        sendConfidence: meta.riskScore <= 3 ? 90 : meta.riskScore <= 6 ? 78 : 65,
        humanReview:   meta.riskScore >= 8 || meta.manipulation,
        buyerTone:    'neutral',
        conflictResolutions: []
      }
    },
    tokens: inputTok + outputTok,
    cost:   parseFloat(cost.toFixed(7))
  };
}

module.exports = { masterAgent };
