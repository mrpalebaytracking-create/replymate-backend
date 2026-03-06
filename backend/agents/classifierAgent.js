// backend/agents/classifierAgent.js
// Detects buyer intent, risk level, and what data the pipeline needs.
// Returns a `trace` so buildWhyData can explain WHY this classification was made.

function classifierAgent({ latestBuyerMessage, threadMessages }) {
  const msg   = (latestBuyerMessage || '').trim();
  const lower = msg.toLowerCase();
  const signals = []; // collects human-readable evidence for the Why panel

  let intent = 'general';
  let risk   = 'low';

  // positive_feedback
  if (/^(thanks?(\s+you)?|thank\s+you(\s+(so\s+much|very\s+much|for\s+everything))?|cheers|great(\s+(service|seller))?|brilliant|excellent|amazing|wonderful|fantastic|perfect|love\s+it|received(\s+it)?|all\s+good|happy\s+with\s+it|pleased|very\s+pleased|satisfied|no\s+problem|no\s+worries|not\s+a\s+problem|sure|noted|understood|got\s+it|ok|okay|fine|alright|pleasure|my\s+pleasure|well\s+packed|fast\s+delivery|quick\s+delivery|arrived\s+(fast|quickly|safely)|as\s+described|as\s+expected|happy\s+days)[\s!.]*$/i.test(msg)) {
    intent = 'positive_feedback';
    signals.push('buyer sent a short closing or positive message');
  }
  // legal threat
  else if (/\b(solicitor|lawyer|legal\s+action|sue\b|court\b|trading\s+standards|citizen\s+advice|small\s+claims|ombudsman|fraud|scam|fake|counterfeit|not\s+genuine|report\s+(you|this|to\s+ebay)|negative\s+feedback\s+unless|going\s+public)\b/i.test(lower)) {
    intent = 'legal_threat'; risk = 'high';
    const m = lower.match(/solicitor|lawyer|legal action|sue|court|trading standards|fraud|scam|fake|counterfeit|report/i);
    signals.push(`legal or threat language detected: "${m ? m[0] : 'escalation keyword'}"`);
  }
  // fraud / not as described
  else if (/\b(not\s+(genuine|authentic|real|original)|fake|replica|counterfeit|not\s+as\s+described|completely\s+different|wrong\s+item|totally\s+wrong)\b/i.test(lower)) {
    intent = 'fraud_claim'; risk = 'high';
    signals.push('buyer making authenticity or wrong-item claim');
  }
  // damaged
  else if (/\b(broken|damaged|cracked|smashed|shattered|scratched|dented|bent|snapped|defective|faulty|not\s+working|doesn'?t\s+work|stopped\s+working|dead\s+on\s+arrival|doa|arrived\s+broken|arrived\s+damaged|came\s+broken)\b/i.test(lower)) {
    intent = 'damaged_item'; risk = 'medium';
    const m = lower.match(/broken|damaged|cracked|faulty|not working|defective|dead on arrival/i);
    signals.push(`damage keyword detected: "${m ? m[0] : 'damage claim'}"`);
  }
  // return
  else if (/\b(return|send\s+(it\s+)?back|returning|want\s+(to\s+)?return|like\s+to\s+return|need\s+to\s+return|return\s+label|return\s+process|return\s+policy)\b/i.test(lower)) {
    intent = 'return'; risk = 'medium';
    signals.push('buyer requesting a return');
  }
  // refund
  else if (/\b(refund|money\s+back|reimburse|get\s+my\s+money|want\s+a\s+refund|full\s+refund|partial\s+refund|compensation)\b/i.test(lower)) {
    intent = 'refund'; risk = 'medium';
    signals.push('buyer requesting a refund or compensation');
  }
  // cancellation
  else if (/\b(cancel|cancellation|cancel\s+my\s+order|don'?t\s+want\s+it\s+anymore|changed\s+my\s+mind|no\s+longer\s+need|stop\s+the\s+order)\b/i.test(lower)) {
    intent = 'cancellation'; risk = 'medium';
    signals.push('buyer requesting order cancellation');
  }
  // not received / tracking
  else if (/\b(where\s+is|not\s+(arrived|received|here|delivered|shown\s+up)|haven'?t\s+received|still\s+waiting|hasn'?t\s+(arrived|come|turned\s+up)|no\s+sign\s+of|overdue|late|delayed|track(ing)?|any\s+update(\s+on)?|been\s+waiting|estimated\s+delivery|when\s+will\s+(it\s+)?arrive|delivery\s+date)\b/i.test(lower)) {
    intent = 'tracking';
    signals.push('buyer asking about delivery or order status');
  }
  // off-platform
  else if (/\b(whatsapp|telegram|text\s+me|call\s+me|my\s+(phone|number|email)|contact\s+me\s+directly|outside\s+ebay|off\s+ebay)\b/i.test(lower)) {
    intent = 'off_platform'; risk = 'high';
    signals.push('buyer attempting off-platform contact');
  }
  // discount
  else if (/\b(discount|lower\s+the\s+price|best\s+price|cheaper|reduce|negotiate|any\s+chance\s+of)\b/i.test(lower)) {
    intent = 'discount_request';
    signals.push('buyer asking for a discount or price reduction');
  }
  // shipping inquiry
  else if (/\b(shipping|postage|delivery\s+(cost|time|speed|option)|how\s+long\s+(does|will)\s+(shipping|delivery)|do\s+you\s+ship\s+to|dispatch|send\s+to)\b/i.test(lower)) {
    intent = 'shipping_inquiry';
    signals.push('buyer asking about shipping or postage');
  }
  // item question (pre-purchase product query)
  else if (/\b(does\s+(it|this)\s+(come|include|have)|is\s+(it|this)\s+(compatible|suitable|right|correct)|what\s+(size|colou?r|material)|how\s+(big|small|tall|wide|heavy)|fits?|compatible|measurements?|dimensions?|specifications?|included|comes?\s+with|is\s+(it\s+)?separate)\b/i.test(lower)) {
    intent = 'item_question';
    const m = lower.match(/does (it|this) come|comes? with|included|separate|compatible|specification/i);
    signals.push(`product specification question: "${m ? m[0] : 'item query'}"`);
  }

  // Extract order ID from message
  const orderIdMatch = msg.match(/\b(\d{2}-\d{5}-\d{5}|\d{12,15})\b/);
  const extractedOrderId = orderIdMatch ? orderIdMatch[0] : null;
  if (extractedOrderId) signals.push(`order ID found in message: ${extractedOrderId}`);

  // Extract buyer sign-off name
  const buyerNameMatch = msg.match(/(?:regards?|thanks?|cheers)[,\s]+([A-Z][a-z]+)\s*$/);
  const buyerName = buyerNameMatch ? buyerNameMatch[1] : null;

  const needsOrder = ['tracking', 'return', 'refund', 'cancellation', 'damaged_item'].includes(intent);

  if (signals.length === 0) signals.push('no specific intent pattern matched — classified as general enquiry');

  return {
    intent,
    risk,
    extracted:  { orderId: extractedOrderId, buyerName },
    needs:      { order: needsOrder },
    missing:    [],
    trace: {
      intent,
      risk,
      signals,
      buyer_name_in_message: buyerName,
      order_id_in_message:   extractedOrderId,
      message_length:        msg.length,
      is_short:              msg.length < 30
    }
  };
}

module.exports = { classifierAgent };
