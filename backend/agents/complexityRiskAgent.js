// agents/complexityRiskAgent.js — ReplyMate Pro v8.1
// Lightweight gpt-4o-mini call — ONLY fires for complex messages.
// Produces: jurisdiction signals, financial exposure, do-not-say list,
//           human review flag, resolution options.
//
// Complexity triggers (any one = fire):
//   - toneTrajectory === 'escalating'
//   - manipulationFlag === true
//   - existingEbayCase === true
//   - sellerPreviousPromises.length > 0
//   - intent in [refund, return, damaged_item, cancellation, legal_threat]
//   - riskScore from classifier >= 5

const { callOpenAIJSON } = require('./writerModels');

const COMPLEX_INTENTS = new Set(['refund', 'return', 'damaged_item', 'cancellation', 'legal_threat', 'fraud_claim']);

function shouldRunComplexityRisk({ intent, conversationState }) {
  if (COMPLEX_INTENTS.has(intent))                         return true;
  if (conversationState.toneTrajectory === 'escalating')   return true;
  if (conversationState.manipulationFlag)                  return true;
  if (conversationState.existingEbayCase)                  return true;
  if (conversationState.sellerPreviousPromises.length > 0) return true;
  return false;
}

async function complexityRiskAgent({ intent, conversationState, dataFetch, latestBuyerMessage, amountsMentioned }) {
  const dt    = dataFetch?.trace    || {};
  const order = dataFetch?.fetched?.order;

  const orderLine    = order ? `Order ${order.orderId} | Status: ${order.status}` : 'No order data';
  const trackingLine = dt.tracking_found
    ? `${dt.tracking_carrier || ''} ${dt.tracking_number || ''} | ${dt.delivery_status} | Overdue: ${dt.is_overdue ? 'YES' : 'no'}`
    : `No tracking | eBay connected: ${dt.ebay_connected ? 'yes' : 'no'}`;

  const SYSTEM = `You are an eBay seller protection specialist. Assess legal risk, financial exposure, and the safest resolution path.
UK law: Consumer Rights Act 2015, Trading Standards, Small Claims Court.
US law: credit card chargebacks, PayPal disputes, BBB.
eBay rules: Money Back Guarantee, defect rate, seller level protection.
Return ONLY valid JSON. No markdown.`;

  const USER = `INTENT: ${intent}
BUYER MESSAGE: "${(latestBuyerMessage || '').slice(0, 400)}"
TONE TRAJECTORY: ${conversationState.toneTrajectory}
MANIPULATION: ${conversationState.manipulationFlag ? `YES — ${conversationState.manipulationReason}` : 'no'}
SELLER PREVIOUS PROMISES: ${conversationState.sellerPreviousPromises.join('; ') || 'none'}
EXISTING EBAY CASE: ${conversationState.existingEbayCase ? 'YES' : 'no'}
AMOUNTS MENTIONED: ${(amountsMentioned || []).join(', ') || 'none'}
ORDER: ${orderLine}
TRACKING: ${trackingLine}

Return this JSON:
{
  "humanReviewRequired": <boolean>,
  "humanReviewReason": "<null or specific reason>",
  "legalJurisdictionSignals": "<null or e.g. 'UK buyer citing Trading Standards — Consumer Rights Act 2015 applies'>",
  "ebayAccountRisk": "<low|medium|high>",
  "estimatedFinancialExposure": "<low (under £20)|medium (£20-100)|high (over £100)|unknown>",
  "doNotSayList": ["<specific phrases never to use — e.g. 'our mistake', 'I guarantee'>"],
  "mustSayList": ["<things that must appear — e.g. 'reference eBay Resolution Centre'>"],
  "resolutionOptions": [
    {
      "option": "<resolution path>",
      "estimatedCost": "<e.g. £0, partial £X, full item value>",
      "riskToSeller": "<low|medium|high>",
      "recommended": <boolean>
    }
  ],
  "sellerIsProtectedBy": "<null or specific eBay policy / law protecting seller here>",
  "precedentRisk": "<low|medium|high>",
  "feedbackProtectionTips": ["<specific things reply should say to protect feedback score>"]
}`;

  try {
    const result = await callOpenAIJSON(SYSTEM, USER, 'gpt-4o-mini', 500);
    return { ok: true, ...result.parsed, tokens: result.tokens, cost: result.cost };
  } catch (err) {
    console.warn('[complexityRisk] failed (non-fatal):', err.message);
    return {
      ok: false,
      humanReviewRequired: false,
      humanReviewReason: null,
      legalJurisdictionSignals: null,
      ebayAccountRisk: 'low',
      estimatedFinancialExposure: 'unknown',
      doNotSayList: [],
      mustSayList: [],
      resolutionOptions: [],
      sellerIsProtectedBy: null,
      precedentRisk: 'low',
      feedbackProtectionTips: []
    };
  }
}

module.exports = { complexityRiskAgent, shouldRunComplexityRisk };
