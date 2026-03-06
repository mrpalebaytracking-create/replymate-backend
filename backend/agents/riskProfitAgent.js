// agents/riskProfitAgent.js — ReplyMate Pro v5.0
// CALL 2 — Agent 3 (Risk Assessor) + Agent 4 (Profit Protector) combined
// Model: GPT-4o-mini  |  Both agents share identical inputs, single structured response.

const { callOpenAIJSON } = require('./writerModels');

const SYSTEM_PROMPT = `You are a dual-role eBay seller protection specialist.

ROLE 1 — RISK ASSESSOR:
Evaluate legal, financial, and reputational risk of this buyer interaction.
- UK jurisdiction: Consumer Rights Act 2015, Trading Standards, Citizens Advice, Small Claims Court
- US jurisdiction: credit card chargebacks, PayPal disputes, BBB complaints
- eBay-specific: defect rate impact, seller level risks, Money Back Guarantee forced resolutions
- Buyer profile signals: new account + high-value claim = elevated fraud risk
- Conversation trajectory: fifth angry message is far higher risk than first query
Generate a specific do-not-say list and must-say list for the writer.

ROLE 2 — PROFIT PROTECTOR:
Identify the most financially intelligent resolution path.
- Calculate real cost of each resolution option
- Flag precedent risks (what does agreeing to X mean for future disputes?)
- Identify feedback protection opportunities
- Flag when eBay's own rules actually protect the seller — buyer may not be entitled to what they're asking
- Identify cases where a small concession closes a dispute that would otherwise cost much more

RETURN ONLY valid JSON. No markdown, no explanation.`;

async function riskProfitAgent({ classification, conversationState, dataFetch, productTitle, orderValue }) {
  const order    = dataFetch?.fetched?.order;
  const tracking = dataFetch?.fetched?.tracking || [];
  const dt       = dataFetch?.trace || {};

  const orderSummary = order
    ? `Order ${order.orderId} | Status: ${order.status} | Payment: ${order.paymentStatus} | Items: ${(order.items || []).map(i => `${i.qty}x ${i.title}`).join(', ')}`
    : 'No order data retrieved';

  const trackingSummary = dt.tracking_found
    ? `${dt.tracking_carrier || 'Unknown carrier'} ${dt.tracking_number || ''} | Status: ${dt.delivery_status} | Overdue: ${dt.is_overdue ? 'YES' : 'no'} | Est. delivery: ${dt.estimated_delivery || 'unknown'}`
    : `No tracking data | eBay connected: ${dt.ebay_connected ? 'yes' : 'no'} | Order found: ${dt.order_found ? 'yes' : 'no'}`;

  const userPrompt = `PRIMARY INTENT: ${classification.primaryIntent}
ALL INTENTS: ${classification.allIntents.map(i => `${i.intent}(${Math.round(i.confidence * 100)}%)`).join(', ')}
RISK SCORE FROM CLASSIFIER: ${classification.riskScore}/10
BUYER TONE: ${classification.buyerTone}
MANIPULATION: ${classification.manipulationFlag ? `YES — ${classification.manipulationReason}` : 'no'}
IMPLICIT SIGNALS: ${classification.implicitSignals.join('; ') || 'none'}
AMOUNTS MENTIONED: ${classification.entities.amountsMentioned.join(', ') || 'none'}

CONVERSATION STATE:
- Messages in thread: ${conversationState.messageCount}
- Tone trajectory: ${conversationState.toneTrajectory}
- Previous promises by seller: ${conversationState.sellerPreviousPromises.join('; ') || 'none'}
- Existing eBay case: ${conversationState.existingEbayCase ? 'YES — elevated risk' : 'no'}
- Relationship score: ${conversationState.relationshipScore}/5

EBAY ORDER: ${orderSummary}
TRACKING: ${trackingSummary}
PRODUCT: ${productTitle || 'unknown'}

Return this exact JSON:

{
  "risk": {
    "finalScore": <integer 1-10 — your assessed score after considering ALL factors above>,
    "finalLevel": "<low|medium|high>",
    "flags": [<specific risk flags — each a clear one-liner>],
    "doNotSayList": [<specific words and phrases to NEVER use in this reply — be precise, e.g. "I guarantee", "our mistake", "I promise it will arrive">],
    "mustSayList": [<things that MUST be included — e.g. "reference eBay Resolution Centre", "ask for photo evidence">],
    "constraints": [<actionable writing rules for the writer agent — specific to this situation>],
    "humanReviewRequired": <boolean — true if this reply is high-stakes enough that seller should review before sending>,
    "humanReviewReason": "<null or the specific reason review is needed>",
    "escalationPath": "<junior|senior|risk_specialist>",
    "legalJurisdictionSignals": "<null or description — e.g. 'UK buyer mentioning Trading Standards — Consumer Rights Act 2015 applies'>",
    "ebayAccountRisk": "<low|medium|high — risk to seller account standing, defect rate, or top-rated status>"
  },
  "profitProtection": {
    "estimatedFinancialExposure": "<low (under £20)|medium (£20-100)|high (over £100)|unknown>",
    "resolutionOptions": [
      {
        "option": "<description of resolution path>",
        "estimatedCost": "<e.g. full item value £X, partial £X, £0>",
        "riskToSeller": "<low|medium|high>",
        "feedbackOutcome": "<likely|unlikely|neutral> positive feedback if chosen",
        "recommended": <boolean — true for the single best option>
      }
    ],
    "guidance": [<specific financial protection guidance — reference actual intent and data>],
    "precedentRisk": "<low|medium|high>",
    "precedentExplanation": "<null or what agreeing to something in this reply sets as precedent>",
    "feedbackProtectionTips": [<specific things the reply should do or say to maximise positive feedback outcome>],
    "sellerIsProtectedBy": "<null or specific eBay policy / consumer law point that actually protects the seller here>"
  }
}`;

  try {
    const result = await callOpenAIJSON(SYSTEM_PROMPT, userPrompt, 'gpt-4o-mini', 1100);
    return {
      ok:               true,
      risk:             result.parsed.risk,
      profitProtection: result.parsed.profitProtection,
      tokens:           result.tokens,
      cost:             result.cost
    };
  } catch (err) {
    console.error('[riskProfitAgent] failed, using safe fallback:', err.message);
    return {
      ok:    false,
      error: err.message,
      risk: {
        finalScore:             classification.riskScore || 3,
        finalLevel:             classification.risk || 'low',
        flags:                  [],
        doNotSayList:           ['guarantee', 'definitely will', 'I promise', 'our fault', 'our mistake', 'we messed up'],
        mustSayList:            [],
        constraints:            [
          'Never suggest off-eBay communication',
          'Do not admit fault or liability',
          'Do not promise refund unprompted',
          'Never invent tracking or order details'
        ],
        humanReviewRequired:    false,
        humanReviewReason:      null,
        escalationPath:         classification.suggestedEscalation || 'senior',
        legalJurisdictionSignals: null,
        ebayAccountRisk:        'low'
      },
      profitProtection: {
        estimatedFinancialExposure: 'unknown',
        resolutionOptions:          [],
        guidance:                   ['Follow standard eBay seller protection guidelines'],
        precedentRisk:              'low',
        precedentExplanation:       null,
        feedbackProtectionTips:     ['Respond promptly and professionally'],
        sellerIsProtectedBy:        null
      },
      tokens: 0,
      cost:   0
    };
  }
}

module.exports = { riskProfitAgent };
