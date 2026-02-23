// routes/ebay.js — eBay OAuth 2.0 flow
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const supabase = require('../db/supabase');

const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// ── GET /ebay/connect?license_key=RM-XXXX — start OAuth flow ─────────────
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
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly'
    ].join(' '),
    state: license_key // pass license key through OAuth flow
  });

  res.redirect(`${EBAY_AUTH_URL}?${params.toString()}`);
});

// ── GET /ebay/callback — eBay redirects here after seller approves ─────────
router.get('/callback', async (req, res) => {
  const { code, state: license_key, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=${error}`);
  }

  if (!code || !license_key) {
    return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=missing_params`);
  }

  try {
    // Exchange code for access token
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

    // Get eBay username
    const userRes = await fetch('https://api.ebay.com/sell/account/v1/privilege', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json().catch(() => ({}));
    const ebayUsername = userData.sellerRegistrationSeller?.registrationSite || 'eBay Account';

    // Get user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('license_key', license_key)
      .single();

    if (!user) return res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=user_not_found`);

    // Save to ebay_accounts table
    const tokenExpiry = new Date(Date.now() + tokenData.expires_in * 1000);

    const { data: existingAccount } = await supabase
      .from('ebay_accounts')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_primary', true)
      .single();

    if (existingAccount) {
      await supabase.from('ebay_accounts').update({
        ebay_token: tokenData.access_token,
        ebay_refresh_token: tokenData.refresh_token || null,
        token_expires_at: tokenExpiry.toISOString(),
        ebay_username: ebayUsername
      }).eq('id', existingAccount.id);
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

    // Also update user record
    await supabase.from('users').update({ ebay_username: ebayUsername }).eq('id', user.id);

    res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_connected=true&username=${encodeURIComponent(ebayUsername)}`);

  } catch (err) {
    console.error('eBay OAuth error:', err);
    res.redirect(`${process.env.CUSTOMER_DASHBOARD_URL}/settings?ebay_error=server_error`);
  }
});

// ── GET /ebay/token?license_key=RM-XXX — extension fetches its token ──────
router.get('/token', async (req, res) => {
  const key = req.headers['x-license-key'] || req.query.license_key;
  if (!key) return res.status(401).json({ error: 'No license key' });

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('license_key', key)
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid key' });

  const { data: account } = await supabase
    .from('ebay_accounts')
    .select('ebay_token, ebay_username, token_expires_at')
    .eq('user_id', user.id)
    .eq('is_primary', true)
    .single();

  if (!account) return res.json({ connected: false });

  // Check if token expired
  if (account.token_expires_at && new Date() > new Date(account.token_expires_at)) {
    return res.json({ connected: false, reason: 'token_expired' });
  }

  res.json({
    connected: true,
    token: account.ebay_token,
    username: account.ebay_username
  });
});

module.exports = router;
