// backend/agents/classifierAgent.js

function extractOrderId(text) {
  // Common eBay order id format: 14-14213-17793 or 22-14181-68411
  const m = String(text || '').match(/\b\d{2}-\d{5}-\d{5}\b/);
  return m ? m[0] : null;
}

function classifyIntent(message) {
  // keep your existing classifier logic (simple + cheap)
  const msg = (message || '').toLowerCase();

  const patterns = {
    tracking:         [/track/i, /where.*(order|package|item|shipment)/i, /not received/i, /delivery date/i],
    return:           [/return/i, /send.*back/i, /exchange/i],
    refund:           [/refund/i, /money back/i, /charge.?back/i],
    damaged_item:     [/damaged/i, /broken/i, /cracked/i, /defective/i, /not working/i],
    cancellation:     [/cancel/i, /changed my mind/i],
    legal_threat:     [/lawyer/i, /legal action/i, /sue/i, /court/i, /report you/i],
    fraud_claim:      [/scam/i, /fake/i, /counterfeit/i],
    off_platform:     [/whatsapp/i, /paypal.*direct/i, /email.*direct/i, /phone/i]
  };

  let bestIntent = 'general';
  let bestScore = 0;

  for (const [intent, regexes] of Object.entries(patterns)) {
    let score = 0;
    for (const r of regexes) if (r.test(msg)) score++;
    if (score > bestScore) { bestScore = score; bestIntent = intent; }
  }

  const highRisk = ['legal_threat', 'fraud_claim', 'off_platform'].includes(bestIntent);
  const mediumRisk = ['return', 'refund', 'damaged_item', 'cancellation'].includes(bestIntent);

  return {
    intent: bestIntent,
    confidence: Math.min(bestScore * 30 + 20, 95),
    risk: highRisk ? 'high' : mediumRisk ? 'medium' : 'low'
  };
}

function classifierAgent({ latestBuyerMessage, threadMessages }) {
  const text = latestBuyerMessage || '';
  const orderId = extractOrderId(text) || extractOrderId((threadMessages || []).map(m => m.text).join('\n'));

  const { intent, confidence, risk } = classifyIntent(text);

  // Decide required data
  const needs = {
    order: false,
    tracking: false
  };

  if (['tracking', 'refund', 'return', 'damaged_item', 'cancellation'].includes(intent)) {
    needs.order = true;
    needs.tracking = ['tracking'].includes(intent);
  }

  // If no orderId, we still “need” it but will ask buyer for it later
  const missing = [];
  if (needs.order && !orderId) missing.push('order_id');

  return {
    agent: 'classifier',
    intent,
    confidence,
    risk,
    extracted: { orderId },
    needs,
    missing
  };
}

module.exports = { classifierAgent };
