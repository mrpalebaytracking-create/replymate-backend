// backend/agents/profitProtectionAgent.js
// Protects the seller from financial and reputational harm.
// Adds guidance based on order/tracking data and intent.
// Returns a trace of what it found and what guidance it applied.

function profitProtectionAgent({ intent, fetched }) {
  const guidance = [];
  const actions  = [];

  const tracking    = fetched?.tracking || [];
  const order       = fetched?.order;
  const hasTracking = tracking.some(t => t.trackingNumber);
  const orderStatus = order?.status || '';

  // ── Tracking / not received ────────────────────────────────────────────
  if (intent === 'tracking') {
    if (hasTracking) {
      guidance.push('Confirm shipment and provide carrier and tracking number');
      guidance.push('Set delivery expectations without making hard promises');
      guidance.push('Do not offer refund or replacement until delivery window has passed');
      actions.push('referenced live tracking data in reply');
    } else if (order) {
      guidance.push('Order found but no tracking available yet — state item is being prepared');
      guidance.push('Avoid promising specific delivery dates without tracking data');
      actions.push('order exists but tracking not yet available');
    } else {
      guidance.push('No order data — direct buyer to check eBay order notifications');
      actions.push('no order data available — gave general guidance');
    }
  }

  // ── Refund ─────────────────────────────────────────────────────────────
  if (intent === 'refund') {
    guidance.push('Do not commit to refund until buyer has followed return process');
    guidance.push('Direct buyer to open eBay return request — this creates audit trail');
    guidance.push('Avoid the word "refund" as a promise — use "resolution" instead');
    actions.push('protected against premature refund commitment');
  }

  // ── Return ─────────────────────────────────────────────────────────────
  if (intent === 'return') {
    guidance.push('Guide buyer to start eBay return request — do not accept return outside eBay');
    guidance.push('Do not approve refund before item is received back and inspected');
    actions.push('directed to official return process');
  }

  // ── Cancellation ───────────────────────────────────────────────────────
  if (intent === 'cancellation') {
    if (orderStatus && /SHIPPED|FULFILLED/i.test(orderStatus)) {
      guidance.push('Item is already dispatched — cancellation is not possible');
      guidance.push('Offer return as alternative once item arrives');
      actions.push('order dispatched — offered return path instead');
    } else if (orderStatus && /AWAITING|UNSHIPPED/i.test(orderStatus)) {
      guidance.push('Order not yet shipped — cancellation may be possible');
      guidance.push('Advise buyer to open cancellation request through eBay');
      actions.push('order not yet shipped — cancellation route available');
    } else {
      guidance.push('Could not confirm dispatch status — advise contacting eBay support');
      actions.push('order status unclear');
    }
  }

  // ── Damaged item ───────────────────────────────────────────────────────
  if (intent === 'damaged_item') {
    guidance.push('Do not offer compensation before receiving photo evidence');
    guidance.push('Once photos received, assess whether to replace, refund, or dispute');
    guidance.push('Keep buyer on eBay platform — all documentation stays visible');
    actions.push('required evidence before any financial commitment');
  }

  // ── Discount request ───────────────────────────────────────────────────
  if (intent === 'discount_request') {
    guidance.push('Decline politely without damaging the relationship');
    guidance.push('Do not offer a discount — it sets a precedent and cuts margin');
    actions.push('held firm on pricing');
  }

  // ── Item question ──────────────────────────────────────────────────────
  if (intent === 'item_question') {
    guidance.push('Only confirm specs that are clearly stated in the listing');
    guidance.push('Do not guess or estimate product specs — refer buyer to the listing');
    actions.push('confirmed only what listing states');
  }

  if (actions.length === 0) actions.push('no specific financial protection guidance needed');

  return {
    agent:   'profit_protection',
    guidance,
    trace: {
      intent,
      actions_taken:  actions,
      guidance_count: guidance.length
    }
  };
}

module.exports = { profitProtectionAgent };
