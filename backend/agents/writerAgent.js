// backend/agents/writerAgent.js
const { callOpenAI, callAnthropic } = require('../agents/writerModels');

function buildSystemPrompt(user) {
  return `You are an expert eBay customer service assistant writing on behalf of the seller.

SELLER:
- Business: ${user.business_name || 'eBay Store'}
- Name to sign: ${user.signature_name || user.name || 'The Seller'}
- Tone: ${user.reply_tone || 'professional'}

RULES:
- Be ${user.reply_tone || 'professional'}, helpful, concise
- Never invent order/tracking/product details
- Never admit fault/liability
- Never suggest off-eBay comms
- End with the seller name signature`;
}

async function writerAgent({ user, latestBuyerMessage, threadMessages, reasoning, riskLevel }) {
  const systemPrompt = buildSystemPrompt(user);

  const threadText = Array.isArray(threadMessages) && threadMessages.length
    ? threadMessages.slice(-10).map(m => `${(m.role || 'buyer').toUpperCase()}: ${String(m.text || '').trim()}`).join('\n')
    : '';

  const userPrompt =
`LATEST BUYER MESSAGE:
"${latestBuyerMessage}"

THREAD (most recent last):
${threadText || '(not provided)'}

FACTS (from eBay API, if any):
- ${reasoning.facts.join('\n- ') || '(none)'}

CONSTRAINTS:
- ${reasoning.constraints.join('\n- ')}

IF INFO IS MISSING:
- Ask 1 short clarifying question, do not guess.

Now write the reply (under 150 words unless necessary). End with the seller signature.`;

  // Routing: high risk or if OpenAI fails -> Anthropic
  if (riskLevel === 'high') {
    return callAnthropic(systemPrompt, userPrompt);
  }

  try {
    return await callOpenAI(systemPrompt, userPrompt);
  } catch {
    return callAnthropic(systemPrompt, userPrompt);
  }
}

module.exports = { writerAgent };
