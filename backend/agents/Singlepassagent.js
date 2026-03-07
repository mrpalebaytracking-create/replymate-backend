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

const fetch = require('node-fetch');

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
    res.setHeader('Cache-Control',      'no-cache');
    res.setHeader('Connection',         'keep-alive');
    res.setHeader('X-Accel-Buffering',  'no');
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
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') resolve();
          continue;
        }
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

module.exports = { singlePassAgent };
