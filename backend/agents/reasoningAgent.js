// backend/agents/reasoningAgent.js
// Assembles facts, identifies what to say, and makes the key decision about
// what approach the writer should take. Returns a rich trace for the Why panel.

function reasoningAgent({ classifier, dataFetch, risk, profit, productTitle, productDescription }) {
  const facts       = [];
  const questions   = [];
  const decisions   = []; // trace of reasoning decisions
  const dataSources = []; // trace of what data was used

  const order    = dataFetch?.fetched?.order;
  const tracking = dataFetch?.fetched?.tracking || [];
  const dt       = dataFetch?.trace || {};

  // ── Facts from eBay API ────────────────────────────────────────────────
  if (order) {
    facts.push(`Order ID: ${order.orderId}`);
    if (order.status)        facts.push(`Order status: ${order.status}`);
    if (order.paymentStatus) facts.push(`Payment: ${order.paymentStatus}`);
    if (order.shipToName)    facts.push(`Buyer name: ${order.shipToName}`);
    if (order.items?.length) {
      const itemList = order.items.map(i => `${i.qty}× ${i.title}`).join('; ');
      facts.push(`Item(s): ${itemList}`);
    }
    dataSources.push('eBay order data');
  }

  if (tracking.length > 0) {
    const t = tracking[0];
    if (t.carrier || t.trackingNumber) {
      facts.push(`Tracking: ${[t.carrier, t.trackingNumber].filter(Boolean).join(' ')}`);
    }
    if (dt.tracking_events?.length > 0) {
      const latest = dt.tracking_events[0];
      if (latest.description) facts.push(`Latest tracking update: ${latest.description}${latest.date ? ' (' + latest.date + ')' : ''}`);
    }
    if (dt.estimated_delivery) facts.push(`Estimated delivery: ${dt.estimated_delivery}`);
    dataSources.push('live tracking data');
  }

  // ── Product title from listing ─────────────────────────────────────────
  // Use API-fetched title first, fall back to what the extension passed
  const effectiveProductTitle = (order?.items?.[0]?.title) || productTitle || null;
  if (effectiveProductTitle) {
    facts.push(`Product: ${effectiveProductTitle}`);
    dataSources.push('product listing title');
  }

  // ── Product description from listing page ──────────────────────────────
  const effectiveDesc = (productDescription || '').trim();
  if (effectiveDesc.length > 30) {
    // Include a trimmed snippet in facts so the writer can reference it
    facts.push(`Listing description (excerpt): ${effectiveDesc.slice(0, 400)}`);
    dataSources.push('product listing description');
  }

  // ── Intent-specific reasoning decisions ───────────────────────────────
  const intent = classifier.intent;

  if (intent === 'item_question' && effectiveProductTitle) {
    const titleLower = effectiveProductTitle.toLowerCase();
    const descLower  = (productDescription || '').toLowerCase();
    const combined   = titleLower + ' ' + descLower;

    const componentKeywords = ['pump', 'cable', 'charger', 'adapter', 'case', 'bag', 'remote',
      'battery', 'manual', 'instructions', 'stand', 'mount', 'strap', 'bracket', 'holder',
      'cover', 'pad', 'mat', 'screen', 'filter', 'lens', 'key', 'lock', 'valve', 'nozzle',
      'hose', 'tube', 'connector', 'clip', 'hook', 'handle', 'wheel', 'feet', 'base'];

    const inTitle = componentKeywords.filter(k => titleLower.includes(k));
    const inDescOnly = componentKeywords.filter(k => !titleLower.includes(k) && descLower.includes(k));

    if (inTitle.length > 0) {
      decisions.push(`product title confirms these components are included: ${inTitle.join(', ')}`);
      decisions.push('confirmed directly from listing title — safe to state to buyer');
    }
    if (inDescOnly.length > 0) {
      decisions.push(`listing description also mentions: ${inDescOnly.join(', ')}`);
      decisions.push('cross-referenced title and description before answering');
    }
    if (inTitle.length === 0 && inDescOnly.length === 0) {
      decisions.push('neither title nor description explicitly confirms the queried component');
      decisions.push('directed buyer to check full listing description for exact specs');
    }

    // Store description availability for Why panel
    if (descLower.length > 50) dataSources.push('product listing description');
  }

  if (intent === 'tracking') {
    if (dt.delivery_status === 'delivered') {
      decisions.push('tracking shows item was delivered — buyer may have missed it');
      decisions.push('asked buyer to check with neighbours / safe place before escalating');
    } else if (dt.delivery_status === 'out_for_delivery') {
      decisions.push('tracking shows item is out for delivery today');
      decisions.push('informed buyer delivery is imminent');
    } else if (dt.delivery_status === 'returned') {
      decisions.push('tracking shows item was returned to sender — needs investigation');
      decisions.push('escalated to investigate with courier');
    } else if (dt.delivery_status === 'in_transit' && dt.estimated_delivery && !dt.is_overdue) {
      decisions.push(`item is in transit — estimated delivery ${dt.estimated_delivery} has not passed yet`);
      decisions.push('asked buyer to wait until estimated delivery date before taking action');
    } else if (dt.delivery_status === 'in_transit' && dt.is_overdue) {
      decisions.push('estimated delivery date has passed — item is overdue');
      decisions.push('raised concern with courier and offered to investigate');
    } else if (!dt.tracking_found) {
      if (!dt.ebay_connected) {
        decisions.push('eBay account not connected — could not fetch live tracking');
      } else if (!dt.order_found) {
        decisions.push('could not match a specific order — asked buyer to check eBay notifications');
      } else {
        decisions.push('order found but no tracking data available yet');
      }
    }
  }

  if (intent === 'damaged_item') {
    decisions.push('asked buyer for photo evidence before committing to any resolution');
    decisions.push('no fault admitted — documentation required first');
  }

  if (intent === 'refund') {
    decisions.push('directed buyer through eBay official resolution process');
    decisions.push('no refund promised — kept options open');
  }

  if (intent === 'return') {
    decisions.push('guided buyer through return process without pre-approving refund');
  }

  if (intent === 'cancellation') {
    if (order?.status && /SHIPPED|FULFILLED/i.test(order.status)) {
      decisions.push('order is already dispatched — cancellation not possible');
      decisions.push('offered return as alternative path');
    } else {
      decisions.push('order not yet shipped — cancellation may be possible');
    }
  }

  if (intent === 'legal_threat' || intent === 'fraud_claim') {
    decisions.push('high-risk message — escalated to Risk Specialist');
    decisions.push('reply stays neutral: no admissions, no arguments');
    decisions.push('directed to eBay Resolution Centre to keep everything documented');
  }

  // ── Missing data questions ─────────────────────────────────────────────
  if (classifier?.missing?.includes('order_id') || dataFetch?.missing?.includes('order_id')) {
    questions.push('No order ID found — asked buyer to confirm their order number');
  }
  if (dataFetch?.missing?.includes('ebay_oauth')) {
    questions.push('eBay account not connected — could not fetch live data');
  }

  // ── Default decision if nothing specific fired ─────────────────────────
  if (decisions.length === 0) {
    decisions.push('reviewed message and drafted a professional, helpful reply');
  }
  if (dataSources.length === 0) {
    dataSources.push('buyer message content');
  }

  return {
    agent:       'reasoning',
    facts,
    questions,
    constraints: [...(risk?.constraints || []), ...(profit?.guidance || [])],
    // Trace — read by buildWhyData
    trace: {
      intent,
      product_title:        effectiveProductTitle,
      description_available: effectiveDesc.length > 30,
      data_sources_used:    dataSources,
      decisions,
      questions,
      delivery_status:      dt.delivery_status   || null,
      estimated_delivery:   dt.estimated_delivery || null,
      is_overdue:           dt.is_overdue         || false,
      tracking_carrier:     dt.tracking_carrier   || null,
      tracking_number:      dt.tracking_number    || null,
      latest_tracking_event: dt.tracking_events?.[0]?.description || null,
      ebay_connected:       dt.ebay_connected     || false,
      order_found:          dt.order_found        || false
    }
  };
}

module.exports = { reasoningAgent };
