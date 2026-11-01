/**
 * Shopify Admin GraphQL API.
 * Auth: a Dev Dashboard app (client ID + secret → client credentials grant, token valid ~24 h, refreshed here),
 * or a legacy custom-app Admin API token (shpat_…).
 */
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

const normShop = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^admin\.shopify\.com\/store\//, "");

function shopHost(shop) {
  const s = normShop(shop);
  if (!s) throw new Error("Enter your store's myshopify.com address");
  return s.includes(".") ? s : `${s}.myshopify.com`;
}

// Base URL (overridable for tests).
const base = (shop) => process.env.SHOPIFY_BASE_URL || `https://${shopHost(shop)}`;

async function fetchJson(url, opts, timeout = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: r.status, body, headers: r.headers };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Shopify didn't answer in time");
    throw new Error(`Couldn't reach Shopify: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(t);
  }
}

// A usable access token; refreshes client-credentials tokens and saves them on the store doc.
async function tokenFor(store) {
  if (store.authType === "token") {
    if (!store.accessToken) throw new Error("Add the Admin API access token");
    return store.accessToken;
  }
  if (store.accessToken && store.tokenExpires && store.tokenExpires > new Date(Date.now() + 5 * 60000)) return store.accessToken;
  if (!store.clientId || !store.clientSecret) throw new Error("Add the app's Client ID and Client secret");
  const { status, body } = await fetchJson(`${base(store.shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: store.clientId, client_secret: store.clientSecret }).toString(),
  });
  if (status !== 200 || !body.access_token) {
    const why = body.error_description || body.error || body.errors || body.raw || `HTTP ${status}`;
    throw new Error(
      `Shopify didn't issue a token (${typeof why === "string" ? why : JSON.stringify(why)}). Check the Client ID and secret, that the app is installed on ${shopHost(store.shop)}, and that the app and store are in the same Shopify organization.`
    );
  }
  store.accessToken = body.access_token;
  store.tokenExpires = new Date(Date.now() + (Number(body.expires_in) || 86399) * 1000);
  if (store.save) await store.save();
  return store.accessToken;
}

async function gql(store, query, variables = {}, attempt = 0) {
  const token = await tokenFor(store);
  const { status, body } = await fetchJson(`${base(store.shop)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (status === 401 && store.authType === "client" && attempt === 0) {
    store.tokenExpires = new Date(0);
    return gql(store, query, variables, 1);
  }
  if (status === 401 || status === 403) throw new Error(`Shopify refused access (${status}). ${store.authType === "token" ? "Check the access token." : "Check the app is installed on the store."}`);
  if (status === 429 || body.errors?.some?.((e) => e.extensions?.code === "THROTTLED")) {
    if (attempt > 5) throw new Error("Shopify is rate-limiting requests; try again in a minute");
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return gql(store, query, variables, attempt + 1);
  }
  if (status >= 400) throw new Error(`Shopify error ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    if (/access denied|ACCESS_DENIED|scope/i.test(msg + JSON.stringify(body.errors))) throw new Error(`Shopify: ${msg}. Give the app the read_orders, read_all_orders, read_products, read_customers and read_inventory scopes (and write_merchant_managed_fulfillment_orders to mark orders fulfilled), then release and reinstall it.`);
    throw new Error(`Shopify: ${msg}`);
  }
  return body.data;
}

module.exports = { gql, tokenFor, shopHost, API_VERSION };
