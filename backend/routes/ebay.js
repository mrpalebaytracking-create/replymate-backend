// routes/ebay.js — eBay OAuth 2.0 + Data Fetching (orders, tracking, items)
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const supabase = require('../db/supabase');

const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// ── Helper: get user's eBay token (auto-refresh if expired) ────────────────
async function getEbayToken(userId) {
  const { data: account } = await supabase
    .from('ebay_accounts')
    .select('id, ebay_token, ebay_refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('is_primary', true)
    .single();

  if (!account) return null;

  // Check if expired — try refresh
  if (account.token_expires_at && new Date() > new Date(account.token_expires_at)) {
    if (!account.ebay_refresh_token) return null;

    try {
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
          scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.account'
        }).toString()
      });

      const tokenData = await tokenRes.json();
      if (tokenData.access_token) {
        const newExpiry = new Date(Date.now() + tokenData.expires_in * 1000);
        await supabase.from('ebay_accounts').update({
          ebay_token: tokenData.access_token,
          token_expires_at: newExpiry.toISOString()
        }).eq('id', account.id);
        return tokenData.access_token;
      }
    } catch (e) {
      console.error('Token refresh failed:', e.message);
    }
    return null;
  }

  return account.ebay_token;
}

// ── License middleware ──────────────────────────────────────────────────────
async function requireLicense(req, res, next) {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'No license key' });
  const { data: user } = await supabase.from('users').select('id, plan').eq('license_key', key).single();
  if (!user) return res.status(401).json({ error: 'Invalid license key' });
  req.user = user;
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
//  OAUTH FLOW
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /ebay/connect?license_key=RM-XXXX — start OAuth ──────────────────
router.get('/connect', (req, res) => {
  const { license_key } = req.query;
  if (!license_key) return res.status(400).send('Missing license_key');

  const params = new URLSearchParams({
    client_id: process.env.EBAY_APP_ID,
    response_type: 'code',
    redirect_uri: process.env.EBAY_RU_NAME,
    scope: [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'
    ].join(' '),
    state: license_key
  });

  res.redirect(`${EBAY_AUTH_URL}?${params.toString()}`);
});

// ── GET /ebay/callback — eBay redirects here ─────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: license_key, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=${error}`);
  }
  if (!code || !license_key) {
    return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=missing_params`);
  }

  try {
    const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');

    const tokenRes = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.EBAY_RU_NAME
      }).toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('eBay token error:', tokenData);
      return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=token_failed`);
    }

    // Get eBay user info
    let ebayUsername = 'eBay Seller';
    try {
      const userRes = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const userData = await userRes.json();
      ebayUsername = userData.username || userData.userId || 'eBay Seller';
    } catch {}

    // Get user from DB
    const { data: user } = await supabase.from('users').select('id').eq('license_key', license_key).single();
    if (!user) return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=user_not_found`);

    const tokenExpiry = new Date(Date.now() + (tokenData.expires_in || 7200) * 1000);

    // Upsert eBay account
    const { data: existing } = await supabase.from('ebay_accounts').select('id').eq('user_id', user.id).eq('is_primary', true).single();

    if (existing) {
      await supabase.from('ebay_accounts').update({
        ebay_token: tokenData.access_token,
        ebay_refresh_token: tokenData.refresh_token || null,
        token_expires_at: tokenExpiry.toISOString(),
        ebay_username: ebayUsername
      }).eq('id', existing.id);
    } else {
      await supabase.from('ebay_accounts').insert({
        user_id: user.id,
        ebay_username: ebayUsername,
        ebay_token: tokenData.access_token,
        ebay_refresh_token: tokenData.refresh_token || null,
        token_expires_at: tokenExpiry.toISOString(),
        is_primary: true
      });
    }

    await supabase.from('users').update({ ebay_username: ebayUsername }).eq('id', user.id);

    res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_connected=true&username=${encodeURIComponent(ebayUsername)}`);

  } catch (err) {
    console.error('eBay OAuth error:', err);
    res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=server_error`);
  }
});

// ── GET /ebay/status — check connection ──────────────────────────────────
router.get('/status', requireLicense, async (req, res) => {
  const token = await getEbayToken(req.user.id);
  if (!token) return res.json({ connected: false });

  const { data: account } = await supabase
    .from('ebay_accounts')
    .select('ebay_username')
    .eq('user_id', req.user.id)
    .eq('is_primary', true)
    .single();

  res.json({ connected: true, username: account?.ebay_username || 'eBay Seller' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DATA FETCHING — used by extension & reply generation
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /ebay/orders — recent orders ─────────────────────────────────────
router.get('/orders', requireLicense, async (req, res) => {
  const token = await getEbayToken(req.user.id);
  if (!token) return res.status(400).json({ error: 'eBay not connected', connect_url: `${process.env.CUSTOMER_DASHBOARD_URL}/settings` });

  try {
    const { buyer, limit = 10 } = req.query;
    let url = `https://api.ebay.com/sell/fulfillment/v1/order?limit=${limit}`;
    if (buyer) url += `&filter=buyer.username:{${buyer}}`;

    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await r.json();

    const orders = (data.orders || []).map(o => ({
      orderId: o.orderId,
      buyer: o.buyer?.username || 'Unknown',
      total: o.pricingSummary?.total?.value || '0',
      currency: o.pricingSummary?.total?.currency || 'USD',
      status: o.orderFulfillmentStatus || 'UNKNOWN',
      date: o.creationDate,
      items: (o.lineItems || []).map(li => ({
        title: li.title,
        sku: li.sku || '',
        quantity: li.quantity,
        price: li.lineItemCost?.value || '0',
        itemId: li.legacyItemId || li.lineItemId
      })),
      tracking: (o.fulfillmentStartInstructions || []).flatMap(f =>
        (f.shippingStep?.shipTo ? [{
          name: f.shippingStep.shipTo.fullName || '',
          trackingNumber: null
        }] : [])
      )
    }));

    // Try to get tracking from fulfillments
    for (const order of orders) {
      try {
        const fRes = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${order.orderId}/shipping_fulfillment`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const fData = await fRes.json();
        order.tracking = (fData.fulfillments || []).map(f => ({
          carrier: f.shippingCarrierCode || '',
          trackingNumber: f.trackingNumber || '',
          shippedDate: f.shippedDate || ''
        }));
      } catch {}
    }

    res.json({ orders, total: data.total || orders.length });
  } catch (err) {
    console.error('eBay orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ── GET /ebay/order/:orderId — single order detail ───────────────────────
router.get('/order/:orderId', requireLicense, async (req, res) => {
  const token = await getEbayToken(req.user.id);
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  try {
    const r = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${req.params.orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const order = await r.json();

    // Get tracking
    let tracking = [];
    try {
      const fRes = await fetch(`https://api.ebay.com/sell/fulfillment/v1/order/${req.params.orderId}/shipping_fulfillment`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const fData = await fRes.json();
      tracking = (fData.fulfillments || []).map(f => ({
        carrier: f.shippingCarrierCode || '',
        trackingNumber: f.trackingNumber || '',
        shippedDate: f.shippedDate || ''
      }));
    } catch {}

    res.json({
      orderId: order.orderId,
      buyer: order.buyer?.username,
      buyerName: order.buyer?.buyerRegistrationAddress?.fullName || '',
      total: order.pricingSummary?.total?.value,
      status: order.orderFulfillmentStatus,
      paymentStatus: order.orderPaymentStatus,
      date: order.creationDate,
      items: (order.lineItems || []).map(li => ({
        title: li.title,
        sku: li.sku || '',
        quantity: li.quantity,
        price: li.lineItemCost?.value,
        itemId: li.legacyItemId || li.lineItemId
      })),
      shippingAddress: {
        name: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName || '',
        city: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.city || '',
        state: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.stateOrProvince || '',
        country: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode || ''
      },
      tracking
    });
  } catch (err) {
    console.error('eBay order detail error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ── GET /ebay/item/:itemId — item/listing detail ─────────────────────────
router.get('/item/:itemId', requireLicense, async (req, res) => {
  const token = await getEbayToken(req.user.id);
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  try {
    const r = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${req.params.itemId}|0`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const item = await r.json();

    res.json({
      itemId: req.params.itemId,
      title: item.title || '',
      price: item.price?.value || '',
      currency: item.price?.currency || 'USD',
      condition: item.condition || '',
      description: item.shortDescription || '',
      image: item.image?.imageUrl || '',
      categoryPath: item.categoryPath || '',
      itemUrl: item.itemWebUrl || ''
    });
  } catch (err) {
    console.error('eBay item error:', err);
    res.status(500).json({ error: 'Failed to fetch item details' });
  }
});

// ── POST /ebay/search-order — find order by buyer name or email ──────────
router.post('/search-order', requireLicense, async (req, res) => {
  const token = await getEbayToken(req.user.id);
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  const { buyer_name, order_id } = req.body;

  try {
    let url = 'https://api.ebay.com/sell/fulfillment/v1/order?limit=5';
    if (order_id) {
      url += `&orderIds=${order_id}`;
    }

    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await r.json();

    let orders = data.orders || [];

    // Filter by buyer name if provided
    if (buyer_name && !order_id) {
      const search = buyer_name.toLowerCase();
      orders = orders.filter(o => {
        const username = (o.buyer?.username || '').toLowerCase();
        const fullName = (o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName || '').toLowerCase();
        return username.includes(search) || fullName.includes(search);
      });
    }

    const results = orders.slice(0, 5).map(o => ({
      orderId: o.orderId,
      buyer: o.buyer?.username || 'Unknown',
      total: o.pricingSummary?.total?.value || '0',
      status: o.orderFulfillmentStatus,
      date: o.creationDate,
      itemCount: o.lineItems?.length || 0,
      firstItemTitle: o.lineItems?.[0]?.title || ''
    }));

    res.json({ orders: results });
  } catch (err) {
    console.error('eBay search error:', err);
    res.status(500).json({ error: 'Failed to search orders' });
  }
});

// ── Legacy token endpoint (backward compat) ─────────────────────────────
router.get('/token', async (req, res) => {
  const key = req.headers['x-license-key'] || req.query.license_key;
  if (!key) return res.status(401).json({ error: 'No license key' });

  const { data: user } = await supabase.from('users').select('id').eq('license_key', key).single();
  if (!user) return res.status(401).json({ error: 'Invalid key' });

  const { data: account } = await supabase
    .from('ebay_accounts')
    .select('ebay_token, ebay_username, token_expires_at')
    .eq('user_id', user.id)
    .eq('is_primary', true)
    .single();

  if (!account) return res.json({ connected: false });
  if (account.token_expires_at && new Date() > new Date(account.token_expires_at)) {
    return res.json({ connected: false, reason: 'token_expired' });
  }

  res.json({ connected: true, token: account.ebay_token, username: account.ebay_username });
});

module.exports = router;
