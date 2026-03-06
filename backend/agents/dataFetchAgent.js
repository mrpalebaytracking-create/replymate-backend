// backend/agents/dataFetchAgent.js
// Fetches live eBay order and tracking data.
// Returns a rich `trace` of exactly what was found — used by buildWhyData.

const { getEbayToken, fetchOrderAndTracking } = require('../lib/ebayClient');

async function dataFetchAgent({ userId, needs, orderId }) {
  const out = {
    agent:   'data_fetch',
    ok:      true,
    fetched: {},
    missing: [],
    trace: {
      attempted:         false,
      reason:            '',
      order_found:       false,
      product_title:     null,
      order_status:      null,
      payment_status:    null,
      tracking_found:    false,
      tracking_carrier:  null,
      tracking_number:   null,
      tracking_events:   [],    // [{date, location, description}]
      delivery_status:   null,  // 'delivered' | 'in_transit' | 'out_for_delivery' | 'returned' | 'unknown'
      estimated_delivery: null,
      is_overdue:        false,
      ebay_connected:    false
    }
  };

  // Not needed for this intent
  if (!needs.order) {
    out.trace.reason = 'order data not needed for this type of message';
    return out;
  }

  out.trace.attempted = true;

  if (!orderId) {
    out.ok = false;
    out.missing.push('order_id');
    out.trace.reason = 'no order ID found in the conversation';
    return out;
  }

  const token = await getEbayToken(userId);
  if (!token) {
    out.ok = false;
    out.missing.push('ebay_oauth');
    out.trace.reason = 'eBay account not connected — cannot fetch live order data';
    return out;
  }

  out.trace.ebay_connected = true;

  const result = await fetchOrderAndTracking(token, orderId);
  if (!result.ok) {
    out.ok = false;
    out.fetched.error = result;
    out.trace.reason = `eBay API returned an error for order ${orderId}`;
    return out;
  }

  const order    = result.order;
  const tracking = result.tracking || [];

  // Normalise order
  out.fetched.order = {
    orderId:        order.orderId,
    status:         order.orderFulfillmentStatus,
    paymentStatus:  order.orderPaymentStatus,
    created:        order.creationDate,
    buyerUsername:  order.buyer?.username || '',
    shipToName:     order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName || '',
    items:          (order.lineItems || []).map(li => ({
      title: li.title,
      qty:   li.quantity,
      itemId: li.legacyItemId || li.lineItemId
    }))
  };

  out.fetched.tracking = tracking;
  out.trace.order_found    = true;
  out.trace.order_status   = order.orderFulfillmentStatus || null;
  out.trace.payment_status = order.orderPaymentStatus || null;

  // Product title from first line item
  if (out.fetched.order.items && out.fetched.order.items.length > 0) {
    out.trace.product_title = out.fetched.order.items[0].title;
  }

  // Parse tracking events
  if (tracking.length > 0) {
    const t = tracking[0];
    out.trace.tracking_found   = !!(t.trackingNumber);
    out.trace.tracking_carrier = t.carrier || t.shippingCarrierCode || null;
    out.trace.tracking_number  = t.trackingNumber || null;

    // Pull delivery events from checkpoint history
    const checkpoints = t.trackingInfo?.trackingEvents || t.checkpoints || [];
    out.trace.tracking_events = checkpoints.slice(0, 5).map(e => ({
      date:        e.eventDate || e.date || null,
      location:    e.eventAddress?.city || e.location || null,
      description: e.eventDescription || e.description || null
    }));

    // Determine delivery status from latest event
    const latestEvent = (out.trace.tracking_events[0]?.description || '').toLowerCase();
    if (/delivered/i.test(latestEvent))         out.trace.delivery_status = 'delivered';
    else if (/out for delivery/i.test(latestEvent)) out.trace.delivery_status = 'out_for_delivery';
    else if (/return(ed)?|return to sender/i.test(latestEvent)) out.trace.delivery_status = 'returned';
    else if (out.trace.tracking_number)         out.trace.delivery_status = 'in_transit';
    else                                        out.trace.delivery_status = 'unknown';

    // Estimated delivery date
    out.trace.estimated_delivery = t.promisedDeliveryDate || t.estimatedDeliveryDate || null;
    if (out.trace.estimated_delivery) {
      const eta = new Date(out.trace.estimated_delivery);
      out.trace.is_overdue = eta < new Date();
    }

    out.trace.reason = `fetched order and tracking for ${orderId}`;
  } else {
    out.trace.reason = `order found (${orderId}) but no tracking data available yet`;
  }

  return out;
}

module.exports = { dataFetchAgent };
