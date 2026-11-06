/**
 * Amazon Selling Partner API. Auth: Login with Amazon (LWA) — the private app's client ID + secret and the
 * refresh token from self-authorising it give a 1-hour access token (cached on the account). India is served
 * by the EU endpoint. Buyer name / phone / address need a Restricted Data Token (Tokens API) and the app's
 * restricted "Direct-to-Consumer Shipping" role.
 */
const zlib = require("zlib");

const LWA_URL = () => process.env.AMAZON_LWA_URL || "https://api.amazon.com/auth/o2/token";
const BASE = () => process.env.AMAZON_SPAPI_BASE || "https://sellingpartnerapi-eu.amazon.com";

async function fetchRaw(url, opts = {}, timeout = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Amazon didn't answer in time");
    throw new Error(`Couldn't reach Amazon: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(t);
  }
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 300) };
  }
};
const why = (body, status) =>
  (body?.errors || [])
    .map((e) => [e.message, e.details].filter(Boolean).join(" — "))
    .join("; ") ||
  body?.error_description ||
  body?.error ||
  body?.raw ||
  `HTTP ${status}`;

async function tokenFor(acc) {
  if (acc.accessToken && acc.tokenExpires && acc.tokenExpires > new Date(Date.now() + 3 * 60000)) return acc.accessToken;
  if (!acc.clientId || !acc.clientSecret || !acc.refreshToken) throw new Error("Add the app's LWA client ID, client secret and refresh token");
  const r = await fetchRaw(LWA_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: acc.refreshToken.trim(), client_id: acc.clientId.trim(), client_secret: acc.clientSecret.trim() }).toString(),
  });
  const body = parse(await r.text());
  if (r.status !== 200 || !body.access_token) throw new Error(`Amazon didn't issue a token (${why(body, r.status)}). Check the client ID, client secret and refresh token.`);
  acc.accessToken = body.access_token;
  acc.tokenExpires = new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000);
  if (acc.save) await acc.save().catch(() => {});
  return acc.accessToken;
}

const qs = (query = {}) => {
  const p = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`);
  return p.length ? `?${p.join("&")}` : "";
};

/**
 * One SP-API call. Retries throttling (429) with back-off. `token` overrides the access token (an RDT).
 * Returns the parsed body ({} for 204).
 */
async function call(acc, method, path, { query, body, token, attempt = 0 } = {}) {
  const tok = token || (await tokenFor(acc));
  const r = await fetchRaw(`${BASE()}${path}${qs(query)}`, {
    method,
    headers: { "x-amz-access-token": tok, "content-type": "application/json", accept: "application/json", "user-agent": "OrdexaGo/1.0 (Language=JavaScript)" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  const data = text ? parse(text) : {};
  if (r.status === 429 && attempt < 5) {
    await new Promise((res) => setTimeout(res, Number(process.env.AMAZON_RETRY_MS || 2000) * (attempt + 1)));
    return call(acc, method, path, { query, body, token, attempt: attempt + 1 });
  }
  if (r.status === 401 && !token && attempt === 0) {
    acc.tokenExpires = new Date(0);
    return call(acc, method, path, { query, body, attempt: 1 });
  }
  if (r.status >= 400) {
    const msg = why(data, r.status);
    const e = new Error(r.status === 403 ? `Amazon refused access (${msg}). Check the app has the needed roles (see the setup guide).` : `Amazon: ${msg}`);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}

// Restricted Data Token for one path (buyer info and shipping address). Falls back without dataElements.
async function rdtFor(acc, method, path, dataElements = ["buyerInfo", "shippingAddress"]) {
  const ask = (withElements) =>
    call(acc, "POST", "/tokens/2021-03-01/restrictedDataToken", { body: { restrictedResources: [{ method, path, ...(withElements ? { dataElements } : {}) }] } });
  let r;
  try {
    r = await ask(true);
  } catch (e) {
    if (e.status !== 400) throw e;
    r = await ask(false);
  }
  if (!r.restrictedDataToken) throw new Error("Amazon didn't issue a restricted data token");
  return r.restrictedDataToken;
}

// Download a document Amazon hands out by URL (feed results, report documents); gunzip when compressed.
async function download(url, compression) {
  const r = await fetchRaw(url, {}, 90000);
  if (r.status >= 400) throw new Error(`Couldn't download Amazon's document (HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  return compression === "GZIP" || (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf;
}

async function upload(url, content, contentType) {
  const r = await fetchRaw(url, { method: "PUT", headers: { "content-type": contentType }, body: content });
  if (r.status >= 300) throw new Error(`Couldn't upload to Amazon (HTTP ${r.status})`);
}

module.exports = { tokenFor, call, rdtFor, download, upload, MARKETPLACE_IN: "A21TJRUUN4KGTV" };
