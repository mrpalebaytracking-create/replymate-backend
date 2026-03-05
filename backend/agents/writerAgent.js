// backend/agents/writerAgent.js
const { callOpenAI, callAnthropic } = require('./writerModels');

// Extract the seller's own writing style from their previous messages in the thread.
// This is the core of "follow the seller's writing method" — we look at what the seller
// has already written and describe their actual patterns to GPT.
function extractSellerStyle(threadMessages) {
  if (!Array.isArray(threadMessages) || threadMessages.length === 0) return null;

  const sellerMsgs = threadMessages
    .filter(m => (m.role || '').toLowerCase() === 'seller')
    .map(m => (m.text || '').trim())
    .filter(t => t.length > 20); // ignore very short ones

  if (sellerMsgs.length === 0) return null;

  const traits = [];

  // Greeting style
  const greetings = sellerMsgs.map(m => {
    const match = m.match(/^(Hi|Hello|Dear|Hey|Good\s+\w+)[,\s]+(\w+)?/i);
    return match ? match[0] : null;
  }).filter(Boolean);
  if (greetings.length > 0) {
    traits.push(`Starts messages with: "${greetings[0]}"`);
  }

  // Closing/sign-off style
  const closings = sellerMsgs.map(m => {
    const match = m.match(/(Kind regards|Best regards|Many thanks|Warm regards|Thanks|Cheers|Take care)[,\s\n]+\w+/i);
    return match ? match[0] : null;
  }).filter(Boolean);
  if (closings.length > 0) {
    traits.push(`Signs off with: "${closings[0]}"`);
  }

  // Avg sentence length — short/punchy vs long/detailed
  const avgLen = sellerMsgs.reduce((s, m) => s + m.length, 0) / sellerMsgs.length;
  if (avgLen < 80)  traits.push('Writes short, punchy messages — never long paragraphs');
  else if (avgLen > 250) traits.push('Writes detailed, thorough messages with multiple sentences');
  else traits.push('Writes moderate-length messages — clear but not overly long');

  // Formality
  const hasSlang = sellerMsgs.some(m => /\b(gonna|wanna|kinda|sorta|hey|yep|nope|yeah)\b/i.test(m));
  const hasFormal = sellerMsgs.some(m => /\b(sincerely|hereby|aforementioned|kindly|please be advised)\b/i.test(m));
  if (hasSlang)   traits.push('Uses casual, friendly language');
  else if (hasFormal) traits.push('Uses formal, professional language');

  // Uses buyer name?
  const usesBuyerName = sellerMsgs.some(m => /^(Hi|Hello|Dear)\s+[A-Z][a-z]+/i.test(m));
  if (usesBuyerName) traits.push('Addresses the buyer by their first name');

  // Emoji usage
  const usesEmoji = sellerMsgs.some(m => /[\u{1F300}-\u{1F9FF}]/u.test(m));
  if (usesEmoji) traits.push('Occasionally uses emoji');

  return traits.length > 0 ? traits : null;
}

function buildSystemPrompt(user, threadMessages) {
  const sellerStyle = extractSellerStyle(threadMessages);
  const styleBlock = sellerStyle
    ? `\nSELLER'S OWN WRITING STYLE (extracted from their previous messages — YOU MUST MIRROR THIS):\n${sellerStyle.map(t => `- ${t}`).join('\n')}\n`
    : '';

  return `You are an expert eBay customer service assistant writing on behalf of the seller.

SELLER:
- Business: ${user.business_name || 'eBay Store'}
- Name: ${user.signature_name || user.name || 'The Seller'}
- Tone: ${user.reply_tone || 'professional'}
${styleBlock}
CRITICAL RULES:
1. MIRROR THE SELLER'S OWN WRITING STYLE shown above — not the buyer's style
2. Be ${user.reply_tone || 'professional'}, helpful, and natural
3. Never invent order/tracking/product details
4. Never admit fault or liability
5. Never suggest off-eBay communication
6. Always end with seller's name signature

RESPONSE LENGTH GUIDE:
- If buyer says "Thanks" → Reply with "You're welcome!" (SHORT!)
- If buyer says "Thank you" → Reply with "My pleasure!" (SHORT!)
- If buyer confirms ("OK", "Understood") → Brief acknowledgment (SHORT!)
- If buyer asks a question → Answer directly but concisely
- If buyer has a problem → Address it with empathy but stay concise

NEVER write long paragraphs for short buyer messages!`;
}

async function writerAgent({ user, latestBuyerMessage, threadMessages, reasoning, riskLevel }) {
  const systemPrompt = buildSystemPrompt(user, threadMessages);

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
