// backend/agents/writerAgent.js - IMPROVED VERSION
const { callOpenAI, callAnthropic } = require('./writerModels');

function buildSystemPrompt(user) {
  return `You are an expert eBay customer service assistant writing on behalf of the seller.

SELLER:
- Business: ${user.business_name || 'eBay Store'}
- Name: ${user.signature_name || user.name || 'The Seller'}
- Tone: ${user.reply_tone || 'professional'}

CRITICAL RULES:
1. MATCH THE BUYER'S MESSAGE LENGTH AND ENERGY
2. Be ${user.reply_tone || 'professional'}, helpful, and natural
3. Never invent order/tracking/product details
4. Never admit fault or liability
5. Never suggest off-eBay communication
6. Always end with seller's name signature

RESPONSE LENGTH GUIDE:
- If buyer says "Thanks" → Reply with "You're welcome!" (SHORT!)
- If buyer says "Thank you" → Reply with "My pleasure!" (SHORT!)
- If buyer says "Appreciate it" → Reply with "You're welcome! Have a great day!" (SHORT!)
- If buyer confirms ("OK", "Understood") → Brief acknowledgment (SHORT!)
- If buyer asks a question → Answer directly but concisely
- If buyer has a problem → Address it with empathy but stay concise

NEVER write long paragraphs for short buyer messages!`;
}

async function writerAgent({ user, latestBuyerMessage, threadMessages, reasoning, riskLevel }) {
  const systemPrompt = buildSystemPrompt(user);

  const threadText = Array.isArray(threadMessages) && threadMessages.length
    ? threadMessages.slice(-10).map(m => `${(m.role || 'buyer').toUpperCase()}: ${String(m.text || '').trim()}`).join('\n')
    : '';

  // Analyze message length to determine response style
  const buyerMsgLength = (latestBuyerMessage || '').trim().length;
  const isShortMessage = buyerMsgLength < 20;
  const isClosingRemark = /^(thanks?|thank you|appreciate|pleasure|cheers|great|perfect|okay|ok|got it|understood)/i.test(latestBuyerMessage);

  const userPrompt = `
🎯 CRITICAL: Respond to the buyer's LATEST message. Do NOT repeat what the seller already said.

━━━ BUYER'S LATEST MESSAGE ━━━
"${latestBuyerMessage}"

MESSAGE TYPE DETECTED: ${isClosingRemark ? '🔴 CLOSING REMARK - KEEP RESPONSE SHORT!' : isShortMessage ? '🟡 SHORT MESSAGE - KEEP RESPONSE BRIEF!' : '🟢 DETAILED MESSAGE'}

CONVERSATION HISTORY (for context - DO NOT REPEAT):
${threadText || '(no previous messages)'}

FACTS FROM EBAY API:
${reasoning.facts && reasoning.facts.length > 0 ? reasoning.facts.map(f => `• ${f}`).join('\n') : '• No additional facts'}

CONSTRAINTS:
${reasoning.constraints && reasoning.constraints.length > 0 ? reasoning.constraints.map(c => `• ${c}`).join('\n') : '• Be helpful and professional'}

━━━ YOUR TASK ━━━
${isClosingRemark ? `
🔴 THIS IS A CLOSING REMARK ("${latestBuyerMessage}")
RESPONSE MUST BE SHORT! Examples:
- "You're welcome!"
- "My pleasure!"
- "You're welcome! Have a great day!"
- "Glad I could help!"

DO NOT write long paragraphs! Maximum 2 sentences!
` : isShortMessage ? `
🟡 THIS IS A SHORT MESSAGE
Keep your response brief (under 50 words)
` : `
🟢 THIS IS A DETAILED MESSAGE
You can provide a fuller response, but stay under 100 words
`}

Write your response now. End with:
"Best regards,
${user.signature_name || user.name || 'The Seller'}"`;

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
