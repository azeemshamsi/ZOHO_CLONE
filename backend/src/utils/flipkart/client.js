/**
 * Flipkart Marketplace Seller API. Auth: a self-access application's App ID + secret → an access token
 * (client credentials, ~60 days; cached on the account, encrypted). Base https://api.flipkart.net.
 */
const BASE = () => (process.env.FLIPKART_API_BASE || "https://api.flipkart.net").replace(/\/$/, "");

async function fetchRaw(url, opts = {}, timeout = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Flipkart didn't answer in time");
    throw new Error(`Couldn't reach Flipkart: ${e.cause?.code || e.message}`);
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
const why = (b, status) =>
  (Array.isArray(b?.errors) && b.errors.map((e) => e.description || e.message || e.code).filter(Boolean).join("; ")) ||
  b?.error_description ||
  b?.message ||
  (typeof b?.error === "string" ? b.error : b?.error?.message) ||
  b?.raw ||
  `HTTP ${status}`;

async function tokenFor(acc, force = false) {
  if (!force && acc.accessToken && acc.tokenExpires && acc.tokenExpires > new Date(Date.now() + 3600000)) return acc.accessToken;
  if (!acc.appId || !acc.appSecret) throw new Error("Add the Flipkart App ID and App secret");
  const basic = Buffer.from(`${acc.appId.trim()}:${acc.appSecret.trim()}`).toString("base64");
  const r = await fetchRaw(`${BASE()}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`, { headers: { authorization: `Basic ${basic}`, accept: "application/json" } });
  const body = parse(await r.text());
  if (r.status !== 200 || !body.access_token) throw new Error(`Flipkart didn't issue a token (${why(body, r.status)}). Check the App ID and App secret.`);
  acc.accessToken = body.access_token;
  acc.tokenExpires = new Date(Date.now() + (Number(body.expires_in) || 30 * 86400) * 1000);
  if (acc.save) await acc.save().catch(() => {});
  return acc.accessToken;
}

/** One API call. `binary` returns a Buffer (labels). Retries throttling (429) and one expired token (401). */
async function call(acc, method, path, { body, binary = false, attempt = 0 } = {}) {
  const tok = await tokenFor(acc, attempt === 9);
  const url = /^https?:/.test(path) ? path : `${BASE()}${path}`;
  const r = await fetchRaw(url, {
    method,
    headers: { authorization: `Bearer ${tok}`, accept: binary ? "application/pdf" : "application/json", ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 429 && attempt < 5) {
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    return call(acc, method, path, { body, binary, attempt: attempt + 1 });
  }
  if (r.status === 401 && attempt === 0) return call(acc, method, path, { body, binary, attempt: 9 });
  if (binary && r.status < 400) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  const data = text ? parse(text) : {};
  if (r.status >= 400) {
    const e = new Error(`Flipkart: ${why(data, r.status)}`);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}

module.exports = { tokenFor, call, BASE };
