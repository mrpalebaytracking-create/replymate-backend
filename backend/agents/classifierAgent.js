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
    positive_feedback:[/^thanks?[\s!.]*$/i, /^thank you[\s!.]*$/i, /^cheers[\s!.]*$/i, /^great[\s!.]*$/i, /^perfect[\s!.]*$/i, /^brilliant[\s!.]*$/i, /^excellent[\s!.]*$/i, /^amazing[\s!.]*$/i, /^appreciate it[\s!.]*$/i, /^received[\s!.]*$/i, /^got it[\s!.]*$/i, /^ok(ay)?[\s!.]*$/i, /^sounds good[\s!.]*$/i, /^wonderful[\s!.]*$/i, /thank.*(so much|very much|a lot)/i, /great (seller|service|item|product)/i, /love (it|this)/i, /happy with/i, /well packed/i, /fast (ship|deliver)/i],
    tracking:         [/track/i, /where.*(order|package|item|shipment)/i, /not received/i, /delivery date/i, /when.*(arrive|deliver|ship|get)/i, /hasn.t (arrived|shipped)/i, /shipping status/i],
    return:           [/return/i, /send.*back/i, /exchange/i, /return (policy|label|request)/i],
    refund:           [/refund/i, /money back/i, /charge.?back/i, /reimburse/i],
    damaged_item:     [/damaged/i, /broken/i, /cracked/i, /defective/i, /not working/i, /doesn.t work/i, /faulty/i, /arrived broken/i],
    cancellation:     [/cancel/i, /changed my mind/i, /don.t want/i, /stop.*order/i],
    shipping_inquiry: [/shipping (cost|time|method|option)/i, /how long.*(ship|deliver)/i, /free shipping/i, /international ship/i],
    item_question:    [/compatible/i, /does (it|this) (work|fit)/i, /what.*(size|color|dimension|weight|material)/i, /specs/i, /is (it|this) (new|genuine|authentic)/i],
    discount_request: [/discount/i, /lower price/i, /best price/i, /deal/i, /negotiate/i],
    legal_threat:     [/lawyer/i, /attorney/i, /legal action/i, /sue/i, /court/i, /trading standards/i, /consumer rights/i, /report you/i, /bbb/i],
    fraud_claim:      [/scam/i, /fraud/i, /fake/i, /counterfeit/i, /knock.?off/i, /replica/i, /not (genuine|authentic|real)/i],
    off_platform:     [/whatsapp/i, /paypal.*direct/i, /email.*direct/i, /phone/i, /call me/i, /text me/i, /outside.*ebay/i, /off.*ebay/i]
  };

  let bestIntent = 'general';
  let bestScore = 0;

  for (const [intent, regexes] of Object.entries(patterns)) {
    let score = 0;
    for (const r of regexes) if (r.test(msg)) score++;
    if (score > bestScore) { bestScore = score; bestIntent = intent; }
  }

  const highRisk   = ['legal_threat', 'fraud_claim', 'off_platform'].includes(bestIntent);
  const mediumRisk = ['return', 'refund', 'damaged_item', 'cancellation'].includes(bestIntent);
  const noRisk     = ['positive_feedback', 'shipping_inquiry', 'item_question', 'discount_request'].includes(bestIntent);

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

  // Decide what data this intent requires
  const needs = { order: false, tracking: false };
  if (['tracking', 'refund', 'return', 'damaged_item', 'cancellation'].includes(intent)) {
    needs.order    = true;
    needs.tracking = intent === 'tracking';
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
