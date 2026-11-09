/**
 * Meta Graph API client for WhatsApp Cloud API, Messenger, Instagram and Page comments.
 * Version: META_GRAPH_VERSION (default v26.0, the latest as of Nov 2026). Base: META_GRAPH_BASE (tests point it
 * at a mock server). Errors become GraphError with Meta's code / subcode and a readable message.
 */
const VERSION = () => process.env.META_GRAPH_VERSION || "v26.0";
const BASE = () => (process.env.META_GRAPH_BASE || "https://graph.facebook.com").replace(/\/+$/, "");

class GraphError extends Error {
  constructor(message, { status, code, subcode, type, fbtrace } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.fbtrace = fbtrace;
  }
}

// Friendlier text for the errors people hit while setting up.
function explain(e) {
  const c = e.code;
  if (c === 190) return `The access token is invalid or expired (${e.message}). Make a new System User token in Business Settings and paste it again.`;
  if (c === 10 || c === 200 || (c >= 200 && c < 300)) return `Permission missing: ${e.message}. Check the System User has this asset and the permission, and (for Messenger / Instagram) the app has Advanced Access.`;
  if (c === 100) return `Meta didn't accept the request: ${e.message}`;
  if (c === 131047) return "More than 24 hours since the customer's last message: send an approved template instead.";
  if (c === 131026) return "This number can't receive WhatsApp messages (not on WhatsApp, or hasn't accepted the latest terms).";
  if (c === 131049) return "Meta didn't deliver this marketing message to keep the customer's experience healthy (per-user marketing limit). Try later.";
  if (c === 131050) return "The customer has stopped marketing messages from your business on WhatsApp.";
  if (c === 132000 || c === 132012) return `The template's variables don't match: ${e.message}`;
  if (c === 132001) return "That template doesn't exist in this language, or isn't approved yet.";
  if (c === 130429 || c === 131056 || c === 4 || c === 80007 || c === 613) return "Meta's rate limit was hit; it will be retried.";
  if (c === 10 && /24|window/i.test(e.message)) return "Outside the 24-hour messaging window.";
  return e.message;
}

async function graph(token, method, path, { query = {}, body, form, raw = false, timeout = 20000 } = {}) {
  const url = new URL(/^https?:/.test(path) ? path : `${BASE()}/${VERSION()}/${String(path).replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new GraphError(`Couldn't reach Meta: ${e.name === "TimeoutError" ? "no answer in time" : e.message}`, { status: 0 });
  }
  if (raw) {
    if (!res.ok) throw new GraphError(`Meta returned HTTP ${res.status}`, { status: res.status });
    return res;
  }
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { raw: text };
  }
  if (!res.ok || j.error) {
    const er = j.error || {};
    const err = new GraphError(er.error_user_msg || er.message || `HTTP ${res.status}`, { status: res.status, code: er.code, subcode: er.error_subcode, type: er.type, fbtrace: er.fbtrace_id });
    err.message = explain(err);
    throw err;
  }
  return j;
}

const retryable = (e) => !!e && (e.status === 0 || e.status >= 500 || [4, 80007, 130429, 131056, 613, 131000, 1, 2].includes(e.code));

module.exports = { graph, GraphError, explain, retryable, VERSION, BASE };
