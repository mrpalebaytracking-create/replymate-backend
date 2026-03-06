// agents/preClassifyAgent.js — ReplyMate Pro v5.0
// CALL 1 — Agent 0 (Pre-Processor) + Agent 1 (Classifier) combined
// Model: GPT-4o  |  One API call returns conversation state AND full classification.
// This is the pipeline's foundation — everything downstream inherits its decisions.

const { callOpenAIJSON } = require('./writerModels');

const SYSTEM_PROMPT = `You are an expert eBay customer service analyst with 15 years of experience.
You analyse eBay buyer messages and conversation threads with extreme precision.
You understand buyer psychology, eBay seller protection rules, and UK/US consumer law signals.

RETURN ONLY a valid JSON object. No markdown, no explanation, nothing else.

INTENT DEFINITIONS (pick all that apply, ranked by confidence):
- positive_feedback: thanks, praise, "received it", "all good", closing remarks, acknowledgements
- tracking: where is my order, not received, delivery updates, "still waiting", "been X days/weeks"
- damaged_item: broken, faulty, not working, arrived damaged, dead on arrival, defective
- return: want to return, send back, return label, return process, return policy
- refund: money back, refund, compensation, "get my money back", reimburse
- cancellation: cancel order, changed mind, don't want it, no longer need
- legal_threat: solicitor, lawyer, trading standards, sue, court, ombudsman, citizens advice, "going public", small claims
- fraud_claim: fake, not genuine, counterfeit, not as described, completely wrong item, replica
- off_platform: whatsapp, telegram, email me directly, call me, text me, "outside ebay"
- discount_request: lower the price, best price, any chance of, negotiate, cheaper, reduce
- shipping_inquiry: postage cost, delivery time, do you ship to X, how long will delivery take
- item_question: does it come with, compatible with, what size/colour/material, specifications, included in box, measurements
- dispatch_confirmation: when will you send, has it been dispatched/posted, when are you shipping
- combined_shipping: buy multiple items, combine postage, buying more than one
- payment_confirmation: just paid, payment sent, I've paid, please confirm payment received
- availability: do you have more stock, still available, have you got it in X, in stock
- general: anything not matching above

BUYER TONE (pick one):
positive | neutral | curious | frustrated | angry | threatening | manipulative | confused

RISK SCALE 1-10:
1-3 = routine, no financial/legal risk
4-6 = potential dispute, unhappy buyer, financial exposure possible
7-9 = legal language, fraud claim, serious dispute, high financial exposure
10 = imminent eBay case or legal action`;

async function preClassifyAgent({ latestBuyerMessage, threadMessages }) {
  const thread = Array.isArray(threadMessages) && threadMessages.length > 0
    ? threadMessages
        .slice(-10)
        .map(m => `${(m.role || 'buyer').toUpperCase()}: ${(m.text || '').trim()}`)
        .join('\n')
    : '(no previous messages)';

  const userPrompt = `LATEST BUYER MESSAGE:
"${latestBuyerMessage}"

FULL CONVERSATION HISTORY (most recent 10 messages):
${thread}

Analyse everything above and return this exact JSON — no extra keys, no deviation:

{
  "conversationState": {
    "messageCount": <integer — total messages in thread including latest>,
    "isFirstContact": <boolean — true if this is clearly the first message>,
    "previousIntents": [<array of intent strings detected in prior seller/buyer messages>],
    "toneTrajectory": "<stable|escalating|de-escalating>",
    "sellerPreviousPromises": [<strings describing any commitments seller made — e.g. "promised to dispatch Monday", "said would refund if returned">],
    "existingEbayCase": <boolean — true if any message references an open eBay case or formal dispute>,
    "relationshipScore": <integer 1-5 — 1=complete stranger first message, 5=warm ongoing multi-message conversation>
  },
  "classification": {
    "primaryIntent": "<single most important intent from the list>",
    "allIntents": [
      {"intent": "<intent>", "confidence": <float 0.0-1.0>}
    ],
    "risk": "<low|medium|high>",
    "riskScore": <integer 1-10>,
    "buyerTone": "<tone>",
    "manipulationFlag": <boolean — true if buyer is using strategic emotional leverage>,
    "manipulationReason": "<null or specific description of the tactic being used>",
    "implicitSignals": [<strings describing things the buyer IMPLIES but does not state — e.g. "implies frustration about wait time", "implies they may escalate if no response today">],
    "entities": {
      "orderId": "<eBay order ID string if found, or null>",
      "buyerName": "<first name from message sign-off or greeting, or null>",
      "amountsMentioned": [<strings like '£45', '$100' — any amounts the buyer mentions>],
      "datesMentioned": [<strings like '2 weeks ago', 'last Tuesday', 'ordered on the 5th'>],
      "carriersMentioned": [<carrier or courier names buyer mentions>],
      "productsMentioned": [<product names or descriptions mentioned by buyer>]
    },
    "languageStyle": "<formal_uk|casual_uk|formal_us|casual_us|non_native|unknown>",
    "suggestedEscalation": "<junior|senior|risk_specialist>",
    "shouldUseJuniorAgent": <boolean — true ONLY if: single simple intent + risk score 1-3 + tone positive/neutral/curious + first or second message + zero complexity signals>,
    "juniorAgentReason": "<specific one-line reason for the shouldUseJuniorAgent decision>",
    "signals": [<array of human-readable strings explaining what triggered this classification — used in the Why panel shown to seller>]
  }
}`;

  try {
    const result = await callOpenAIJSON(SYSTEM_PROMPT, userPrompt, 'gpt-4o', 1200);
    return {
      ok:                true,
      conversationState: result.parsed.conversationState,
      classification:    result.parsed.classification,
      tokens:            result.tokens,
      cost:              result.cost
    };
  } catch (err) {
    console.error('[preClassifyAgent] failed, using safe fallback:', err.message);
    // Safe fallback — pipeline continues with conservative defaults
    return {
      ok:    false,
      error: err.message,
      conversationState: {
        messageCount:           Array.isArray(threadMessages) ? threadMessages.length + 1 : 1,
        isFirstContact:         !threadMessages || threadMessages.length === 0,
        previousIntents:        [],
        toneTrajectory:         'stable',
        sellerPreviousPromises: [],
        existingEbayCase:       false,
        relationshipScore:      1
      },
      classification: {
        primaryIntent:       'general',
        allIntents:          [{ intent: 'general', confidence: 0.5 }],
        risk:                'medium',
        riskScore:           5,
        buyerTone:           'neutral',
        manipulationFlag:    false,
        manipulationReason:  null,
        implicitSignals:     [],
        entities: {
          orderId:            null,
          buyerName:          null,
          amountsMentioned:   [],
          datesMentioned:     [],
          carriersMentioned:  [],
          productsMentioned:  []
        },
        languageStyle:        'unknown',
        suggestedEscalation:  'senior',
        shouldUseJuniorAgent: false,
        juniorAgentReason:    'AI classifier failed — conservative fallback applied',
        signals:              ['classifier unavailable — fallback classification used']
      },
      tokens: 0,
      cost:   0
    };
  }
}

module.exports = { preClassifyAgent };
