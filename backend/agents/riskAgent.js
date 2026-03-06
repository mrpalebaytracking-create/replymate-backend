// backend/agents/riskAgent.js
// Assesses risk level and adds constraints to protect the seller.
// Returns a trace explaining what risk factors were found.

function riskAgent({ intent, risk }) {
  const constraints = [];
  const flags       = [];

  // Universal constraints — always apply
  constraints.push('Never suggest off-eBay communication');
  constraints.push('Never invent tracking or order details');
  constraints.push('Do not admit fault or liability');

  // High-risk specifics
  if (risk === 'high') {
    constraints.push('Stay calm and factual — do not escalate or argue');
    constraints.push('Suggest eBay Resolution Centre if dispute is likely');
    flags.push('high-risk intent detected');
  }

  if (intent === 'legal_threat') {
    constraints.push('Do not engage with legal language — stay neutral');
    constraints.push('Redirect to eBay dispute resolution process');
    flags.push('legal threat language in message');
  }

  if (intent === 'fraud_claim') {
    constraints.push('Do not accuse buyer of lying — offer a resolution path');
    constraints.push('Ask for evidence (photos, documentation) before responding further');
    flags.push('authenticity or wrong-item claim');
  }

  if (intent === 'damaged_item') {
    constraints.push('Request photo evidence before offering any resolution');
    constraints.push('Do not offer refund or replacement without documentation');
    flags.push('damage claim — documentation required');
  }

  if (intent === 'refund' || intent === 'return') {
    constraints.push('Do not promise refund before return process is started');
    constraints.push('Reference eBay return policy — keep everything on-platform');
  }

  if (intent === 'off_platform') {
    constraints.push('Decline politely — all communication must stay on eBay');
    constraints.push('Do not share any personal contact details');
    flags.push('off-platform contact attempt');
  }

  const riskReason = flags.length > 0
    ? `${flags.join('; ')}`
    : 'no financial, legal, or escalation signals found';

  return {
    agent:       'risk',
    risk,
    constraints,
    trace: {
      risk_level:  risk,
      risk_reason: riskReason,
      flags,
      escalated:   risk === 'high'
    }
  };
}

module.exports = { riskAgent };
