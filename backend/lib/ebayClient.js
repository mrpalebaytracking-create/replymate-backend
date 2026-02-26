// backend/lib/ebayClient.js
const fetch = require('node-fetch');
const supabase = require('../db/supabase');

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

async function getEbayToken(userId) {
  const { data: account } = await supabase
    .from('ebay_accounts')
    .select('id, ebay_token, ebay_refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('is_primary', true)
    .single();

  if (!account) return null;

  // Refresh if expired
  if (account.token_expires_at && new Date() > new Date(account.token_expires_at)) {
    if (!account.ebay_refresh_token) return null;

    const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');

    const tokenRes = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.ebay_refresh_token,
        // Keep aligned with your /ebay/connect scopes
        scope: [
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.account',
          'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
          'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
          'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
          'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
        ].join(' ')
      }).toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return null;

    const newExpiry = new Date(Date.now() + tokenData.expires_in * 1000);

    await supabase.from('ebay_accounts').update({
      ebay_token: tokenData.access_token,
      token_expires_at: newExpiry.toISOString(),
      ebay_refresh_token: tokenData.refresh_token || account.ebay_refresh_token
    }).eq('id', account.id);

    return tokenData.access_token;
  }

  return account.ebay_token;
}

async function fetchOrderAndTracking(accessToken, orderId) {
  const orderRes = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const order = await orderRes.json();
  if (!orderRes.ok) return { ok: false, error: 'order_fetch_failed', details: order };

  // tracking
  let tracking = [];
  try {
    const fRes = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const fData = await fRes.json();
    if (fRes.ok) {
      tracking = (fData.fulfillments || []).map(f => ({
        carrier: f.shippingCarrierCode || '',
        trackingNumber: f.trackingNumber || '',
        shippedDate: f.shippedDate || '',
        deliveryStatus: f.deliveryStatus || ''
      }));
    }
  } catch {}

  return { ok: true, order, tracking };
}

module.exports = { getEbayToken, fetchOrderAndTracking };
