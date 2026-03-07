// lib/ebayFeedbackClient.js — ReplyMate Pro
// eBay Feedback API + Messaging API calls

const fetch = require('node-fetch');
const { getEbayToken } = require('./ebayClient');

const EBAY_API = 'https://api.ebay.com';

// ── Get feedback for seller (negative + neutral, last N days) ─────────────
async function getFeedbackReceived(userId, { days = 30, limit = 50 } = {}) {
  const token = await getEbayToken(userId);
  if (!token) return { ok: false, error: 'no_token', feedbacks: [] };

  // eBay Post-Order API: feedback
  const url = `${EBAY_API}/post-order/v2/feedback?filter=feedbackType%3ABUYER_FEEDBACK&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[feedbackClient] eBay feedback API error:', res.status, err.slice(0, 200));
      return { ok: false, error: `ebay_${res.status}`, feedbacks: [] };
    }

    const data = await res.json();
    const feedbacks = (data.feedbackList || []).map(f => ({
      feedbackId:    f.feedbackId,
      orderId:       f.legacyOrderId || f.orderId,
      buyerUsername: f.recipientUser || f.reviewUser,
      rating:        (f.feedbackScore < 0 || f.feedbackType === 'NEGATIVE') ? 'negative'
                   : (f.feedbackType === 'NEUTRAL') ? 'neutral' : 'positive',
      comment:       f.comment || '',
      date:          f.creationDate || f.feedbackCreationDate,
      itemTitle:     f.itemTitle || '',
      itemPrice:     f.transactionPrice?.value || null,
    })).filter(f => f.rating === 'negative' || f.rating === 'neutral');

    return { ok: true, feedbacks };
  } catch (err) {
    console.error('[feedbackClient] fetch error:', err.message);
    return { ok: false, error: err.message, feedbacks: [] };
  }
}

// ── Get message thread for an order ──────────────────────────────────────
async function getOrderMessages(userId, orderId) {
  const token = await getEbayToken(userId);
  if (!token) return { ok: false, messages: [] };

  // eBay Post-Order API: messages
  const url = `${EBAY_API}/post-order/v2/inquiry?orderId=${orderId}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    if (res.status === 404) return { ok: true, messages: [], hadChat: false };
    if (!res.ok) return { ok: false, messages: [], hadChat: false };

    const data = await res.json();

    // Also try the messaging endpoint
    const msgUrl = `${EBAY_API}/post-order/v2/casemanagement/order/${orderId}/messages`;
    const msgRes = await fetch(msgUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    let messages = [];
    if (msgRes.ok) {
      const msgData = await msgRes.json();
      messages = (msgData.messages || []).map(m => ({
        role:      m.senderType === 'SELLER' ? 'seller' : 'buyer',
        text:      m.body || m.text || '',
        timestamp: m.creationDate
      }));
    }

    return { ok: true, messages, hadChat: messages.length > 0 };
  } catch (err) {
    return { ok: false, messages: [], hadChat: false };
  }
}

// ── Get order details ─────────────────────────────────────────────────────
async function getOrderDetails(userId, orderId) {
  const token = await getEbayToken(userId);
  if (!token) return null;

  try {
    const res = await fetch(`${EBAY_API}/sell/fulfillment/v1/order/${orderId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      orderId:        data.orderId,
      status:         data.orderFulfillmentStatus,
      paymentStatus:  data.paymentSummary?.payments?.[0]?.paymentStatus,
      createdDate:    data.creationDate,
      items:          (data.lineItems || []).map(i => ({ title: i.title, qty: i.quantity, price: i.lineItemCost?.value })),
      shippedDate:    data.fulfillmentStartInstructions?.[0]?.shippingStep?.shipByDate,
      trackingNumber: data.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.primaryPhone, // placeholder — real tracking is in shipment
    };
  } catch {
    return null;
  }
}

// ── Post public feedback reply (max 80 chars) ─────────────────────────────
async function postFeedbackReply(userId, feedbackId, replyText) {
  const token = await getEbayToken(userId);
  if (!token) return { ok: false, error: 'no_token' };

  // Enforce 80 char limit hard
  const reply = replyText.slice(0, 80).trim();

  try {
    const res = await fetch(`${EBAY_API}/post-order/v2/feedback/${feedbackId}/reply`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ response: reply })
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: err.slice(0, 200) };
    }
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Send private message to buyer ─────────────────────────────────────────
async function sendBuyerMessage(userId, orderId, messageText) {
  const token = await getEbayToken(userId);
  if (!token) return { ok: false, error: 'no_token' };

  try {
    const res = await fetch(`${EBAY_API}/post-order/v2/casemanagement/order/${orderId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: { body: messageText } })
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: err.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Send feedback revision request ───────────────────────────────────────
async function requestFeedbackRevision(userId, feedbackId, messageText) {
  const token = await getEbayToken(userId);
  if (!token) return { ok: false, error: 'no_token' };

  try {
    const res = await fetch(`${EBAY_API}/post-order/v2/feedback/${feedbackId}/revisionrequest`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requestMessage: messageText })
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: err.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Get orders at risk (recently shipped, overdue, or no tracking) ────────
async function getAtRiskOrders(userId) {
  const token = await getEbayToken(userId);
  if (!token) return [];

  try {
    // Get orders from last 30 days that are not delivered
    const url = `${EBAY_API}/sell/fulfillment/v1/order?filter=orderfulfillmentstatus:%7BNOT_STARTED|IN_PROGRESS%7D&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return [];

    const data = await res.json();
    const orders = data.orders || [];
    const now = Date.now();
    const atRisk = [];

    for (const order of orders) {
      const createdDate   = new Date(order.creationDate).getTime();
      const ageHours      = (now - createdDate) / 1000 / 3600;
      const hasTracking   = order.fulfillmentStartInstructions?.some(f => f.shippingStep?.shipTo);
      const reasons       = [];
      let riskScore       = 0;

      if (ageHours > 72 && !hasTracking) { reasons.push('no_tracking'); riskScore += 4; }
      if (ageHours > 120)                { reasons.push('overdue_tracking'); riskScore += 3; }
      if (ageHours > 48 && order.orderFulfillmentStatus === 'NOT_STARTED') { reasons.push('not_dispatched'); riskScore += 5; }

      if (riskScore >= 4) {
        atRisk.push({
          orderId:       order.orderId,
          buyerUsername: order.buyer?.username,
          itemTitle:     order.lineItems?.[0]?.title || '',
          riskReason:    reasons.join('|'),
          riskScore,
          createdDate:   order.creationDate
        });
      }
    }

    return atRisk;
  } catch {
    return [];
  }
}

module.exports = {
  getFeedbackReceived,
  getOrderMessages,
  getOrderDetails,
  postFeedbackReply,
  sendBuyerMessage,
  requestFeedbackRevision,
  getAtRiskOrders
};
