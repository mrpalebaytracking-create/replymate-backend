const fetch = require('node-fetch');
const supabase = require('../db/supabase');

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

function basicAuthHeader() {
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  return `Basic ${credentials}`;
}

async function refreshEbayToken(refreshToken) {
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuthHeader()
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      // IMPORTANT: scopes must match or be subset of what you requested during connect
      scope: [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
      ].join(' ')
    }).toString()
  });

  const data = await res.json();
  if (!data.access_token) {
    const msg = data.error_description || data.error || 'refresh_failed';
    throw new Error(msg);
  }

  return data; // { access_token, expires_in, refresh_token? }
}

async function verifyAccessToken(accessToken) {
  // Lightweight “ping”: if this returns 200, token is valid
  const res = await fetch('https://api.ebay.com/sell/account/v1/privilege', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return { ok: false, status: res.status };

  const json = await res.json().catch(() => ({}));
  return { ok: true, data: json };
}

/**
 * Returns:
 *  - { connected:false, reason } OR
 *  - { connected:true, accessToken, userId, ebayUsername }
 *
 * Auto-refreshes if expired.
 */
async function getValidEbayTokenByLicenseKey(licenseKey) {
  // 1) Find user
  const { data: user, error: uerr } = await supabase
    .from('users')
    .select('id, ebay_username')
    .eq('license_key', licenseKey)
    .single();

  if (uerr || !user) return { connected: false, reason: 'invalid_license' };

  // 2) Find primary account token
  const { data: acct } = await supabase
    .from('ebay_accounts')
    .select('id, ebay_token, ebay_refresh_token, token_expires_at, ebay_username')
    .eq('user_id', user.id)
    .eq('is_primary', true)
    .single();

  if (!acct) return { connected: false, reason: 'no_account' };

  const now = new Date();
  const exp = acct.token_expires_at ? new Date(acct.token_expires_at) : null;
  const isExpired = exp ? now >= exp : false;

  let accessToken = acct.ebay_token;

  // 3) Refresh if expired
  if (isExpired) {
    if (!acct.ebay_refresh_token) return { connected: false, reason: 'expired_no_refresh' };

    const refreshed = await refreshEbayToken(acct.ebay_refresh_token);
    accessToken = refreshed.access_token;

    const newExpiry = new Date(Date.now() + (refreshed.expires_in * 1000));

    await supabase.from('ebay_accounts')
      .update({
        ebay_token: accessToken,
        token_expires_at: newExpiry.toISOString(),
        // eBay may or may not return a new refresh token; keep old if missing
        ebay_refresh_token: refreshed.refresh_token || acct.ebay_refresh_token
      })
      .eq('id', acct.id);
  }

  // 4) Verify token live
  const verify = await verifyAccessToken(accessToken);
  if (!verify.ok) {
    // If token invalid (401), attempt refresh once even if not expired
    if (verify.status === 401 && acct.ebay_refresh_token) {
      try {
        const refreshed = await refreshEbayToken(acct.ebay_refresh_token);
        accessToken = refreshed.access_token;
        const newExpiry = new Date(Date.now() + (refreshed.expires_in * 1000));

        await supabase.from('ebay_accounts')
          .update({
            ebay_token: accessToken,
            token_expires_at: newExpiry.toISOString(),
            ebay_refresh_token: refreshed.refresh_token || acct.ebay_refresh_token
          })
          .eq('id', acct.id);

        const verify2 = await verifyAccessToken(accessToken);
        if (!verify2.ok) return { connected: false, reason: 'verify_failed_after_refresh' };
      } catch (e) {
        return { connected: false, reason: 'refresh_failed' };
      }
    } else {
      return { connected: false, reason: `verify_failed_${verify.status}` };
    }
  }

  return {
    connected: true,
    accessToken,
    userId: user.id,
    ebayUsername: acct.ebay_username || user.ebay_username || null
  };
}

module.exports = {
  getValidEbayTokenByLicenseKey
};
