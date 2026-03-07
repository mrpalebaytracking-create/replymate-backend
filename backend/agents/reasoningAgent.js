// agents/reasoningAgent.js — ReplyMate Pro v5.0
// CALL 3 — Agent 5 (Reasoning / Strategy Builder)
// Model: GPT-4o-mini  |  The brain of the pipeline.
// Does NOT write the reply — writes the brief that tells the Writer exactly what to do.
// Every output is specific to this message, this buyer, this situation.

const { callOpenAIJSON } = require('./writerModels');

const SYSTEM_PROMPT = `You are a master eBay customer service strategist and senior manager.
Your job is NOT to write the reply. Your job is to brief the writer perfectly.

You receive all available data about a buyer interaction and produce:
1. A crystal-clear strategy brief — what this reply must achieve
2. A ranked priority list — what matters most, in order
3. Conflict resolutions — when data contradicts the buyer's claim
4. Human touch instructions — specific phrases, tone, warmth level
5. A precise do/don't matrix — specific to THIS exact message

Think like a senior manager briefing a junior agent before they write a response.
Be specific. Never generic. Every sentence must refer to the actual situation.
If tracking shows delivered but buyer says not received — that is a conflict that needs a decision.
If buyer is manipulating — that needs a strategy, not a template.

RETURN ONLY valid JSON. No markdown, no explanation.`;

async function reasoningAgent({
  classification,
  conversationState,
  dataFetch,
  risk,
  profitProtection,
  productTitle,
  productDescription,
  user,
  latestBuyerMessage
}) {
  const order    = dataFetch?.fetched?.order;
  const dt       = dataFetch?.trace || {};

  // Effective product title — prefer live eBay data over extension scrape
  const effectiveProductTitle = (order?.items?.[0]?.title) || productTitle || null;
  const hasDescription        = (productDescription || '').trim().length > 30;

  // Build structured facts from all available data
  const facts = [];
  if (order) {
    facts.push(`Order ID: ${order.orderId} | Status: ${order.status}`);
    if (order.items?.length) facts.push(`Item(s): ${order.items.map(i => `${i.qty}× ${i.title}`).join('; ')}`);
    if (order.buyerUsername) facts.push(`Buyer username: ${order.buyerUsername}`);
  }
  if (dt.tracking_found) {
    facts.push(`Tracking: ${[dt.tracking_carrier, dt.tracking_number].filter(Boolean).join(' ')}`);
    facts.push(`Delivery status: ${dt.delivery_status}`);
    if (dt.estimated_delivery) facts.push(`Estimated delivery: ${dt.estimated_delivery}${dt.is_overdue ? ' — THIS DATE HAS PASSED (overdue)' : ' — not yet passed'}`);
    if (dt.tracking_events?.[0]?.description) facts.push(`Latest tracking event: "${dt.tracking_events[0].description}"`);
  }
  if (effectiveProductTitle) facts.push(`Product: ${effectiveProductTitle}`);
  if (hasDescription) facts.push(`Listing description available (${productDescription.trim().slice(0, 200)}...)`);
  if (!dt.ebay_connected) facts.push('WARNING: eBay account not connected — no live order data available');
  if (dt.ebay_connected && !dt.order_found) facts.push('WARNING: eBay connected but no matching order found for this conversation');

  // Best resolution from profit agent
  const bestResolution = (profitProtection.resolutionOptions || []).find(r => r.recommended);

  const userPrompt = `BUYER'S LATEST MESSAGE:
"${latestBuyerMessage}"

CLASSIFICATION:
- Primary intent: ${classification.primaryIntent}
- All intents: ${classification.allIntents.map(i => `${i.intent}(${Math.round(i.confidence * 100)}%)`).join(', ')}
- Buyer tone: ${classification.buyerTone}
- Implicit signals: ${classification.implicitSignals.join('; ') || 'none'}
- Manipulation: ${classification.manipulationFlag ? `YES — ${classification.manipulationReason}` : 'no'}
- Language style: ${classification.languageStyle}

CONVERSATION STATE:
- Message count: ${conversationState.messageCount} | First contact: ${conversationState.isFirstContact}
- Tone trajectory: ${conversationState.toneTrajectory} | Relationship score: ${conversationState.relationshipScore}/5
- Seller's previous promises: ${conversationState.sellerPreviousPromises.join('; ') || 'none made'}
- Existing eBay case: ${conversationState.existingEbayCase ? 'YES' : 'no'}

LIVE DATA AVAILABLE:
${facts.length > 0 ? facts.map(f => `• ${f}`).join('\n') : '• No eBay data available'}

RISK:
- Score: ${risk.finalScore}/10 (${risk.finalLevel}) | eBay account risk: ${risk.ebayAccountRisk}
- Must NOT say: ${(risk.doNotSayList || []).join(', ') || 'nothing specific'}
- Must include: ${(risk.mustSayList || []).join(', ') || 'nothing specific'}
- Human review required: ${risk.humanReviewRequired ? `YES — ${risk.humanReviewReason}` : 'no'}
- Legal signals: ${risk.legalJurisdictionSignals || 'none'}

PROFIT PROTECTION:
- Financial exposure: ${profitProtection.estimatedFinancialExposure}
- Best resolution: ${bestResolution ? `${bestResolution.option} (cost: ${bestResolution.estimatedCost})` : 'see options'}
- Seller protected by: ${profitProtection.sellerIsProtectedBy || 'standard eBay policy'}
- Precedent risk: ${profitProtection.precedentRisk}${profitProtection.precedentExplanation ? ` — ${profitProtection.precedentExplanation}` : ''}

SELLER:
- Business: ${user.business_name || 'eBay Store'}
- Signing as: ${user.signature_name || user.name || 'The Seller'}
- Tone preference: ${user.reply_tone || 'professional'}

Now produce the writer brief as JSON:

{
  "strategyBrief": "<2-3 sentences — exactly what this reply needs to achieve, why, and what outcome we want. Must reference the actual situation specifically.>",
  "priorityList": [
    "<#1 — the single most important thing this reply must do>",
    "<#2 — second most important>",
    "<#3 — third, only if genuinely relevant>"
  ],
  "conflictResolutions": [<array of strings — each resolves one conflict between data and buyer claims. Empty array if no conflicts. E.g. 'Tracking shows delivered 3 days ago — reply must reference this specific fact and ask buyer to check with neighbours before escalating'>],
  "sellerActionPhrase": "<phrase implying the seller took real-time action for this buyer — must be accurate to what data we have. E.g. 'I've just pulled up your tracking' if we have tracking, 'I've looked into your order' if we have order data, 'Thank you for getting in touch' if no data>",
  "conversationWarmth": "<cold_professional|warm_professional|friendly|personal> — calibrated to relationship score ${conversationState.relationshipScore}/5 and conversation trajectory>",
  "targetLength": "<short (1-3 sentences)|medium (3-5 sentences)|detailed (5-8 sentences)>",
  "toneCalibration": "<specific tone instruction — e.g. 'empathetic and patient, acknowledge the frustration before giving facts'>",
  "buyerEmotionalNeed": "<what the buyer actually needs to feel from this reply — e.g. 'reassurance that their order is coming', 'to feel heard before getting a solution'>",
  "openingInstruction": "<exactly how the reply should open — specific, not generic. E.g. 'Open by acknowledging the wait without over-apologising' or 'Open warmly using buyer name if available'>",
  "closingInstruction": "<how to close — e.g. 'Close by giving a clear next step and offering to help further' or 'Keep the close brief — they sent a short message'>",
  "doList": [<specific things the reply MUST do — reference actual facts where possible>],
  "dontList": [<specific things the reply MUST NOT do — reference actual risks>],
  "factsToWeaveIn": [<specific data points from live eBay data or product info to include naturally in the reply>],
  "predictedOutcome": "<if this reply is written well, what is the expected buyer response or conversation resolution>"
}`;

  try {
    const result = await callOpenAIJSON(SYSTEM_PROMPT, userPrompt, 'gpt-4o-mini', 650);
    const parsed = result.parsed;

    return {
      ok: true,
      ...parsed,
      // Legacy fields — kept for buildWhyData compatibility
      facts,
      constraints: [...(risk.constraints || []), ...(profitProtection.guidance || [])],
      trace: {
        intent:                classification.primaryIntent,
        product_title:         effectiveProductTitle,
        description_available: hasDescription,
        decisions:             parsed.doList || [],
        delivery_status:       dt.delivery_status   || null,
        estimated_delivery:    dt.estimated_delivery || null,
        is_overdue:            dt.is_overdue         || false,
        tracking_carrier:      dt.tracking_carrier   || null,
        tracking_number:       dt.tracking_number    || null,
        latest_tracking_event: dt.tracking_events?.[0]?.description || null,
        ebay_connected:        dt.ebay_connected     || false,
        order_found:           dt.order_found        || false
      },
      tokens: result.tokens,
      cost:   result.cost
    };
  } catch (err) {
    console.error('[reasoningAgent] failed, using safe fallback:', err.message);
    return {
      ok:                    false,
      error:                 err.message,
      strategyBrief:         'Write a professional, helpful reply addressing the buyer\'s concern without admitting fault or making promises.',
      priorityList:          ['Address the buyer\'s main concern professionally and helpfully'],
      conflictResolutions:   [],
      sellerActionPhrase:    'Thank you for your message',
      conversationWarmth:    'warm_professional',
      targetLength:          'medium',
      toneCalibration:       user.reply_tone || 'professional',
      buyerEmotionalNeed:    'helpful and prompt response',
      openingInstruction:    'Acknowledge the buyer\'s message warmly',
      closingInstruction:    'Offer further assistance and sign off professionally',
      doList:                ['Be helpful and professional', 'Address the buyer\'s question directly'],
      dontList:              ['Do not admit fault', 'Do not suggest off-eBay communication', 'Do not promise outcomes you cannot guarantee'],
      factsToWeaveIn:        [],
      predictedOutcome:      'buyer satisfied with professional response',
      facts,
      constraints:           [...(risk.constraints || []), ...(profitProtection.guidance || [])],
      trace: {
        intent:                classification.primaryIntent,
        product_title:         effectiveProductTitle,
        description_available: hasDescription,
        decisions:             [],
        delivery_status:       dt.delivery_status   || null,
        estimated_delivery:    dt.estimated_delivery || null,
        is_overdue:            dt.is_overdue         || false,
        tracking_carrier:      dt.tracking_carrier   || null,
        tracking_number:       dt.tracking_number    || null,
        latest_tracking_event: null,
        ebay_connected:        dt.ebay_connected     || false,
        order_found:           dt.order_found        || false
      },
      tokens: 0,
      cost:   0
    };
  }
}

module.exports = { reasoningAgent };
