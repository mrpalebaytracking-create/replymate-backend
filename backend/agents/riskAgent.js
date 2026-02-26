// backend/agents/riskAgent.js

function riskAgent({ intent, risk }) {
  const constraints = [];

  // Always
  constraints.push('Never suggest off-eBay communication');
  constraints.push('Never invent tracking/order details');
  constraints.push('Do not admit fault or liability');

  if (risk === 'high') {
    constraints.push('Stay calm and factual; do not escalate');
    constraints.push('If needed, suggest eBay Resolution Center');
  }

  if (intent === 'fraud_claim') {
    constraints.push('Avoid accusing the buyer; offer a resolution path');
  }

  return {
    agent: 'risk',
    risk,
    constraints
  };
}

module.exports = { riskAgent };
