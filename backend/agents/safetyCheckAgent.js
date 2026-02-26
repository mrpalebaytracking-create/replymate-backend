// backend/agents/safetyCheckAgent.js

function safetyCheckAgent({ draft }) {
  let text = String(draft || '').trim();

  // Remove any accidental off-platform suggestions
  text = text.replace(/whatsapp|telegram|paypal|email me|call me|text me/gi, 'eBay messages');

  // Avoid admissions
  text = text.replace(/\b(it'?s our fault|we messed up|our mistake)\b/gi, 'I’m sorry for the inconvenience');

  // Avoid guaranteed promises
  text = text.replace(/\b(guarantee|definitely|100% sure)\b/gi, 'will do our best to');

  return {
    agent: 'safety_check',
    reply: text
  };
}

module.exports = { safetyCheckAgent };
