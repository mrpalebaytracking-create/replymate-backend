// backend/agents/profitProtectionAgent.js

function profitProtectionAgent({ intent, fetched }) {
  const guidance = [];

  const tracking = fetched?.tracking || [];
  const hasTracking = tracking.some(t => t.trackingNumber);
  const orderStatus = fetched?.order?.status || '';

  if (intent === 'tracking') {
    if (hasTracking) {
      guidance.push('Confirm shipment and provide carrier + tracking if present');
      guidance.push('Set expectations on delivery window');
    } else {
      guidance.push('State we are checking shipment status; avoid promising dates');
    }
  }

  if (intent === 'refund' || intent === 'return') {
    guidance.push('Do not promise refund until return process is followed');
    guidance.push('Refer to return policy / official eBay return flow');
  }

  if (intent === 'cancellation') {
    if (orderStatus && /SHIPPED|FULFILLED/i.test(orderStatus)) {
      guidance.push('Explain order may already be dispatched; offer return options');
    } else {
      guidance.push('If not shipped, confirm cancellation steps');
    }
  }

  return {
    agent: 'profit_protection',
    guidance
  };
}

module.exports = { profitProtectionAgent };
