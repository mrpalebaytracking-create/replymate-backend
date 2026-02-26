// backend/agents/reasoningAgent.js

function reasoningAgent({ classifier, dataFetch, risk, profit }) {
  const facts = [];
  const questions = [];

  if (dataFetch?.fetched?.order) {
    const o = dataFetch.fetched.order;
    facts.push(`Order ID: ${o.orderId}`);
    if (o.status) facts.push(`Order status: ${o.status}`);
    if (o.items?.length) facts.push(`Items: ${o.items.map(i => `${i.qty}× ${i.title}`).join('; ')}`);
  }

  const tracking = dataFetch?.fetched?.tracking || [];
  if (tracking.length) {
    const t = tracking[0];
    if (t.carrier || t.trackingNumber) facts.push(`Tracking: ${t.carrier || ''} ${t.trackingNumber || ''}`.trim());
  }

  if (classifier?.missing?.includes('order_id')) {
    questions.push('Could you please confirm your eBay order number so I can check the tracking/status?');
  }
  if (dataFetch?.missing?.includes('ebay_oauth')) {
    questions.push('Seller needs to connect eBay account to fetch live order/tracking data.');
  }

  return {
    agent: 'reasoning',
    facts,
    questions,
    constraints: [...(risk?.constraints || []), ...(profit?.guidance || [])]
  };
}

module.exports = { reasoningAgent };
