// agents/writeValidateAgent.js — ReplyMate Pro v5.1
// CALL 4 — Agent 6 (Writer) only — GPT-4o streaming
// Streams the reply token-by-token to the client.
// Validation runs fire-and-forget AFTER the reply is sent — never blocks the user.

const fetch = require('node-fetch');

// ── Extract seller's writing voice from thread ────────────────────────────
function extractSellerVoice(threadMessages) {
  if (!Array.isArray(threadMessages) || threadMessages.length === 0) return null;
  const msgs = threadMessages
    .filter(m => (m.role || '').toLowerCase() === 'seller')
    .map(m => (m.text || '').trim())
    .filter(t => t.length > 15);
  if (msgs.length === 0) return null;

  const traits = [];
  const openings = msgs.map(m => m.match(/^(Hi|Hello|Dear|Hey|Good\s+\w+)[,\s]+(\w+)?/i)?.[0]).filter(Boolean);
  if (openings.length) traits.push(`Opens with: "${openings[0]}"`);

  const signoffs = msgs.map(m => m.match(/(Kind regards|Best regards|Many thanks|Warm regards|Thanks|Cheers|Take care|Speak soon)[,\s\n]+\w*/i)?.[0]).filter(Boolean);
  if (signoffs.length) traits.push(`Signs off with: "${signoffs[0]}"`);

  const avgLen = msgs.reduce((s, m) => s + m.length, 0) / msgs.length;
  if (avgLen < 80)        traits.push('Very short messages — punchy, never rambles');
  else if (avgLen > 280)  traits.push('Detailed thorough messages');
  else                    traits.push('Moderate length — clear but not verbose');

  const hasSlang  = msgs.some(m => /\b(gonna|wanna|hey|yep|nope|yeah|cheers)\b/i.test(m));
  const hasFormal = msgs.some(m => /\b(sincerely|hereby|kindly note|please be advised)\b/i.test(m));
  if (hasSlang)        traits.push('Casual conversational language');
  else if (hasFormal)  traits.push('Formal polished language');
  else                 traits.push('Natural professional language');

  if (msgs.some(m => /^(Hi|Hello|Dear)\s+[A-Z][a-z]+/i.test(m)))
    traits.push('Addresses buyers by first name');
  if (msgs.some(m => /\b(I'll|we'll|I'm|we're|it's|that's|don't|can't)\b/.test(m)))
    traits.push('Uses contractions naturally');

  return traits.length > 0 ? traits : null;
}

// ── Build writer system prompt ────────────────────────────────────────────
function buildWriterPrompt(user, threadMessages, reasoning, classification, risk) {
  const sign        = user.signature_name || user.name || 'The Seller';
  const biz         = user.business_name  || 'our store';
  const sellerVoice = extractSellerVoice(threadMessages);

  const voiceBlock = sellerVoice
    ? `\nSELLER'S WRITING VOICE — MIRROR THIS:\n${sellerVoice.map(t => `• ${t}`).join('\n')}\n`
    : '';

  const warmthMap = {
    cold_professional: 'professional and efficient — no excessive warmth',
    warm_professional: 'warm and professional — friendly but not over-familiar',
    friendly:          'friendly and personable — good rapport, let that show',
    personal:          'personal and warm — ongoing relationship, reflect that'
  };
  const warmth = warmthMap[reasoning.conversationWarmth] || warmthMap['warm_professional'];

  const prevOpenings = Array.isArray(threadMessages)
    ? threadMessages
        .filter(m => (m.role || '').toLowerCase() === 'seller')
        .map(m => (m.text || '').trim().split('\n')[0].trim())
        .filter(Boolean).slice(-3)
    : [];

  const avoidOpening = prevOpenings.length > 0
    ? `\nDO NOT start with these already used openings:\n${prevOpenings.map(o => `• "${o}"`).join('\n')}\n`
    : '';

  const doNotSay = (risk.doNotSayList || []).length > 0
    ? `\nNEVER USE: ${risk.doNotSayList.join(', ')}`
    : '';

  return `You write eBay customer service replies AS ${sign} from ${biz}.
You ARE this person — not an assistant writing on their behalf.
${voiceBlock}
HUMAN TOUCH — MANDATORY:
• Acknowledge the feeling BEFORE the solution ("Sorry to hear that" before the fix)
• Use time-anchoring: "I've just checked", "I'm looking at this now", "just pulled up your order"
• Use contractions: I'll, it's, we're, don't — sounds human not robotic
• Be SPECIFIC — reference the actual item name, actual wait, actual situation
• One genuine interest signal: "Hope it arrives in time" / "Let me know how you get on"
• Match buyer's register — casual buyer = warmer reply, formal buyer = measured reply
• Vary sign-off to match warmth: sometimes "Thanks," sometimes just "${sign}"

HARD RULES:
• Never suggest off-eBay communication
• Never admit fault or liability  
• Never invent tracking/order details
• Never make promises you cannot keep
• Always end: signature is ${sign}
${doNotSay}
${avoidOpening}
TONE: ${warmth}
LENGTH: ${reasoning.targetLength || 'medium'}

OUTPUT THE REPLY ONLY. No preamble. No explanation. Just the reply, ready to send.`;
}

// ── Build writer user prompt ──────────────────────────────────────────────
function buildWriterUserPrompt(latestBuyerMessage, reasoning, classification) {
  const facts = (reasoning.factsToWeaveIn || []).length > 0
    ? reasoning.factsToWeaveIn.map(f => `• ${f}`).join('\n')
    : '• No live eBay data — write from message content only';

  const priorities = (reasoning.priorityList || ['Address the buyer professionally'])
    .map((p, i) => `${i + 1}. ${p}`).join('\n');

  const doItems = (reasoning.doList || []).map(d => `✓ ${d}`).join('\n') || '✓ Be helpful and professional';
  const dontItems = (reasoning.dontList || []).map(d => `✗ ${d}`).join('\n') || '✗ Do not admit fault';

  const conflicts = (reasoning.conflictResolutions || []).length > 0
    ? `\nCONFLICT RESOLUTIONS — apply exactly:\n${reasoning.conflictResolutions.map(c => `→ ${c}`).join('\n')}`
    : '';

  return `BUYER'S MESSAGE:
"${latestBuyerMessage}"

STRATEGY: ${reasoning.strategyBrief || 'Write a professional helpful reply.'}

PRIORITIES:
${priorities}

OPEN WITH: "${reasoning.sellerActionPhrase || 'Thank you for your message'}" — woven in naturally.
OPENING STYLE: ${reasoning.openingInstruction || 'Warm acknowledgement'}
CLOSING STYLE: ${reasoning.closingInstruction || 'Offer further help, sign off'}
BUYER NEEDS TO FEEL: ${reasoning.buyerEmotionalNeed || 'heard and helped'}

FACTS TO REFERENCE NATURALLY:
${facts}

DO:
${doItems}

DO NOT:
${dontItems}
${conflicts}

Write the reply now.`;
}

// ── Streaming writer — returns reply text via callback ────────────────────
async function streamWriter({ systemPrompt, userPrompt, onChunk, onDone, onError }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

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
    throw new Error(`OpenAI stream error: ${err.slice(0, 200)}`);
  }

  let fullText   = '';
  let inputTok   = 0;
  let outputTok  = 0;

  const body = response.body;
  let buffer = '';

  await new Promise((resolve, reject) => {
    body.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

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
            if (onChunk) onChunk(delta);
          }
          // Capture usage if present (last chunk)
          if (json.usage) {
            inputTok  = json.usage.prompt_tokens     || 0;
            outputTok = json.usage.completion_tokens || 0;
          }
        } catch { /* skip malformed chunks */ }
      }
    });
    body.on('end',   resolve);
    body.on('error', reject);
  });

  const cost = (inputTok * 0.0000025) + (outputTok * 0.00001);
  if (onDone) onDone({ text: fullText, tokens: inputTok + outputTok, cost });
  return { text: fullText, tokens: inputTok + outputTok, cost };
}

// ── Strip preamble ────────────────────────────────────────────────────────
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

// ── Main export ──────────────────────────────────────────────────────────
// onChunk(text) — callback called with each token as it streams
// If onChunk not provided, falls back to non-streaming (for tests/modify)
async function writeValidateAgent({
  user,
  latestBuyerMessage,
  threadMessages,
  reasoning,
  classification,
  risk,
  dataFetch,
  onChunk        // optional streaming callback — called with each token
}) {
  const systemPrompt = buildWriterPrompt(user, threadMessages, reasoning, classification, risk);
  const userPrompt   = buildWriterUserPrompt(latestBuyerMessage, reasoning, classification);

  let fullReply  = '';
  let firstChunk = true;
  let streamTokens = 0;
  let streamCost   = 0;

  await streamWriter({
    systemPrompt,
    userPrompt,
    onChunk: (delta) => {
      // Accumulate and strip preamble from first 60 chars before forwarding
      if (firstChunk) {
        fullReply += delta;
        if (fullReply.length >= 60) {
          const cleaned = stripPreamble(fullReply);
          fullReply = cleaned;
          if (onChunk) onChunk(cleaned);
          firstChunk = false;
        }
        return;
      }
      fullReply += delta;
      if (onChunk) onChunk(delta);
    },
    onDone: ({ text, tokens, cost }) => {
      // Flush any remaining buffered text (short replies)
      if (firstChunk && fullReply) {
        const cleaned = stripPreamble(fullReply);
        fullReply = cleaned;
        if (onChunk) onChunk(cleaned);
      }
      streamTokens = tokens;
      streamCost   = cost;
    }
  });

  return {
    reply:      stripPreamble(fullReply),
    model:      'gpt-4o',
    tokens:     streamTokens,
    cost:       streamCost,
    wasRetried: false,
    validation: { sendConfidence: 88, flags: [], humanReviewRequired: false }
  };
}

module.exports = { writeValidateAgent };
