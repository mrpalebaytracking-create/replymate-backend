// backend/agents/dataFetchAgent.js
const { getEbayToken, fetchOrderAndTracking } = require('../lib/ebayClient');

async function dataFetchAgent({ userId, needs, orderId }) {
  const out = {
    agent: 'data_fetch',
    ok: true,
    fetched: {},
    missing: []
  };

  if (!needs.order) return out;

  if (!orderId) {
    out.ok = false;
    out.missing.push('order_id');
    return out;
  }

  const token = await getEbayToken(userId);
  if (!token) {
    out.ok = false;
    out.missing.push('ebay_oauth');
    return out;
  }

  const result = await fetchOrderAndTracking(token, orderId);
  if (!result.ok) {
    out.ok = false;
    out.fetched.error = result;
    return out;
  }

  // Normalize facts for downstream agents
  const order = result.order;
  const tracking = result.tracking || [];

  out.fetched.order = {
    orderId: order.orderId,
    status: order.orderFulfillmentStatus,
    paymentStatus: order.orderPaymentStatus,
    created: order.creationDate,
    buyerUsername: order.buyer?.username || '',
    shipToName: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName || '',
    items: (order.lineItems || []).map(li => ({
      title: li.title,
      qty: li.quantity,
      itemId: li.legacyItemId || li.lineItemId
    }))
  };

  out.fetched.tracking = tracking;

  return out;
}

module.exports = { dataFetchAgent };
