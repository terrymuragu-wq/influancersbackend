// mpesa.js — KCB Buni M-Pesa STK Push integration
// Uses KCB Buni API (https://api.buni.kcbgroup.com)
// Falls back to a simulated flow when MPESA_MODE=sandbox and no live credentials are reachable.

const { v4: uuid } = require('uuid');

const KCB_ENV = (process.env.KCB_ENV || 'production').toLowerCase();
const KCB_BASE_URL = process.env.KCB_BASE_URL || (KCB_ENV === 'production' ? 'https://api.buni.kcbgroup.com' : 'https://accounts.buni.kcbgroup.com');
const KCB_TOKEN_ENDPOINT = process.env.KCB_TOKEN_ENDPOINT || `${KCB_BASE_URL.replace(/\/$/, '')}/token`;
const KCB_CONSUMER_KEY = process.env.KCB_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY || '';
const KCB_CONSUMER_SECRET = process.env.KCB_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET || '';
const KCB_API_KEY = process.env.KCB_API_KEY || '';
// Callback URL comes ONLY from the environment — never hardcode backend URLs/secrets.
const KCB_CALLBACK_URL = process.env.KCB_CALLBACK_URL || process.env.MPESA_CALLBACK_URL || '';
const KCB_SHORTCODE = process.env.KCB_SHORTCODE || process.env.MPESA_SHORTCODE || '';
const KCB_TILL = process.env.KCB_TILL || KCB_SHORTCODE;
const KCB_STK_ENDPOINT = process.env.KCB_STK_ENDPOINT || `${KCB_BASE_URL.replace(/\/$/, '')}/mm/api/request/1.0.0/stkpush`;
const KCB_QUERY_ENDPOINT = process.env.KCB_QUERY_ENDPOINT || `${KCB_BASE_URL.replace(/\/$/, '')}/mm/api/request/1.0.0/stkpushquery`;
const MODE = (process.env.MPESA_MODE || (KCB_ENV === 'production' ? 'live' : 'sandbox')).toLowerCase();

// Hard network ceiling for every outbound KCB call — a hung upstream can never
// wedge the API. AbortSignal.timeout is built into Node 18+.
const KCB_TIMEOUT_MS = parseInt(process.env.KCB_TIMEOUT_MS || '12000', 10);

// In-memory state for pending simulated transactions (sandbox mode only)
const pending = new Map();

// Cache of KCB OAuth access tokens
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Fetch (and cache) an OAuth access token from KCB Buni.
 * Buni exposes standard OAuth2 client-credentials at /token.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 30_000) return cachedToken;

  if (!KCB_CONSUMER_KEY || !KCB_CONSUMER_SECRET) {
    throw new Error('KCB credentials not configured');
  }

  const creds = Buffer.from(`${KCB_CONSUMER_KEY}:${KCB_CONSUMER_SECRET}`).toString('base64');
  const url = KCB_TOKEN_ENDPOINT;

  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(KCB_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`KCB token request failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  const j = await resp.json();
  cachedToken = j.access_token;
  cachedTokenExpiresAt = Date.now() + ((j.expires_in || 3600) * 1000);
  return cachedToken;
}

/**
 * Build the KCB Buni `invoiceNumber` field.
 *
 * Per KCB Buni support (email from Eddy Munene, API Integrations, Digital
 * Financial Services): the invoice number must contain the KCB Till/Account
 * number followed by the account reference, separated by a hash (#) or hyphen (-).
 *
 *     invoiceNumber = <TILL>#<ACCOUNT_REF>
 *
 * Example: "8112320#MELLA4898E7"
 */
function buildInvoiceNumber(accountRef) {
  const till = String(KCB_TILL || KCB_SHORTCODE || '').trim();
  const ref = String(accountRef || 'MELLA').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'MELLA';
  // Cap total length at 20 chars to stay within KCB limits.
  const combined = `${till}#${ref}`;
  return combined.slice(0, 20);
}

/**
 * Trigger an STK push (customer receives a prompt on their phone).
 *
 * Real KCB Buni STK Push endpoint. If the call fails (network / credentials
 * unavailable) and MPESA_MODE=sandbox, we fall back to a simulated push so the
 * frontend still functions end-to-end for testing.
 */
async function stkPush({ phone, amount, accountRef, description }) {
  // Sandbox / simulated path (used when explicitly requested or when creds are missing)
  const simulated = () => {
    const checkoutId = 'ws_CO_' + Date.now() + '_' + uuid().slice(0, 8);
    const merchantId = uuid().slice(0, 12);
    console.log(`[mpesa:sim] STK push (fallback) phone=${phone} amount=${amount} checkoutId=${checkoutId}`);
    pending.set(checkoutId, { phone, amount, at: Date.now() });
    return {
      MerchantRequestID: merchantId,
      CheckoutRequestID: checkoutId,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
      _simulated: true,
    };
  };

  if (MODE === 'sandbox' && (!KCB_CONSUMER_KEY || !KCB_CONSUMER_SECRET)) {
    return simulated();
  }

  try {
    const token = await getAccessToken();
    const url = KCB_STK_ENDPOINT;

    // KCB Buni STK Push payload (production contract).
    // NOTE: invoiceNumber must be "<TILL>#<ACCOUNT_REF>" per KCB support guidance.
    const payload = {
      phoneNumber: String(phone),
      amount: String(amount),
      invoiceNumber: buildInvoiceNumber(accountRef),
      sharedShortCode: false,
      orgShortCode: String(KCB_TILL || KCB_SHORTCODE || ''),
      orgPassKey: '',
      callbackUrl: KCB_CALLBACK_URL,
      transactionDescription: (description || 'Mella vote').slice(0, 40),
    };

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (KCB_API_KEY) headers['apikey'] = KCB_API_KEY;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(KCB_TIMEOUT_MS),
    });

    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    // KCB Buni returns either the Safaricom-style shape
    //   { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, CustomerMessage }
    // or the Buni-native shape
    //   { header: { statusCode, statusDescription }, response: { MerchantRequestID, CheckoutRequestID, ... } }
    // Normalise both.
    const buniHeader = body && body.header;
    const buniInner = (body && body.response) || {};
    const merged = {
      MerchantRequestID: body.MerchantRequestID || buniInner.MerchantRequestID,
      CheckoutRequestID: body.CheckoutRequestID || buniInner.CheckoutRequestID,
      ResponseCode: body.ResponseCode || buniInner.ResponseCode || (buniHeader && buniHeader.statusCode),
      ResponseDescription: body.ResponseDescription || buniInner.ResponseDescription || (buniHeader && buniHeader.statusDescription),
      CustomerMessage: body.CustomerMessage || buniInner.CustomerMessage || (buniHeader && buniHeader.statusDescription),
    };
    const okStatus = merged.ResponseCode === '0' || merged.ResponseCode === 0 || merged.ResponseCode === undefined;

    if (!resp.ok || !okStatus) {
      console.error('[mpesa:kcb] STK push failed', resp.status, text.slice(0, 300));
      if (MODE === 'sandbox') return simulated();
      throw new Error('stk_push_failed');
    }

    console.log(`[mpesa:kcb] STK push OK phone=${phone} amount=${amount} invoice=${payload.invoiceNumber} checkoutId=${merged.CheckoutRequestID}`);
    // Track live push for callback matching; no auto-resolve.
    pending.set(merged.CheckoutRequestID, { phone, amount, at: Date.now(), live: true });

    return merged;
  } catch (e) {
    console.error('[mpesa:kcb] error:', e.message);
    if (MODE === 'sandbox') return simulated();
    throw e;
  }
}

/**
 * Query the live status of an STK push by CheckoutRequestID.
 * Returns a normalised object:
 *   { resultCode, resultDesc, receipt, raw }
 * resultCode: 0 = success, non-zero = failed/cancelled, null = still pending / unknown
 */
async function queryStkStatus(checkoutId) {
  if (!checkoutId) return { resultCode: null, resultDesc: 'no_checkout', raw: null };
  if (MODE === 'sandbox' || !KCB_CONSUMER_KEY || !KCB_CONSUMER_SECRET) {
    return { resultCode: null, resultDesc: 'sandbox_mode', raw: null };
  }
  try {
    const token = await getAccessToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (KCB_API_KEY) headers['apikey'] = KCB_API_KEY;

    const payload = {
      checkoutRequestID: checkoutId,
      CheckoutRequestID: checkoutId,
      orgShortCode: String(KCB_TILL || KCB_SHORTCODE || ''),
    };

    const resp = await fetch(KCB_QUERY_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(KCB_TIMEOUT_MS),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    const inner = (body && body.response) || body || {};
    const rc = inner.ResultCode ?? inner.resultCode ?? body.ResultCode ?? null;
    const rd = inner.ResultDesc || inner.resultDesc || body.ResultDesc || '';
    const rcp = inner.MpesaReceiptNumber || inner.mpesaReceiptNumber || null;
    const resultCode = (rc === undefined || rc === null || rc === '') ? null : Number(rc);
    return { resultCode, resultDesc: rd, receipt: rcp, raw: body };
  } catch (e) {
    return { resultCode: null, resultDesc: e.message, raw: null };
  }
}

/**
 * Simulates the customer entering their PIN and paying (sandbox only).
 * In production the confirmation comes via the CallBackURL, not this method.
 */
function simulateConfirm(checkoutId, success = true) {
  const item = pending.get(checkoutId);
  if (!item) return null;
  pending.delete(checkoutId);
  return {
    checkoutId,
    success,
    receipt: success ? 'TEST' + Date.now().toString(36).toUpperCase() : null,
    resultCode: success ? 0 : 1032,
    resultDesc: success ? 'The service request is processed successfully.' : 'Request cancelled by user',
  };
}

module.exports = { stkPush, simulateConfirm, queryStkStatus, getAccessToken, MODE };
