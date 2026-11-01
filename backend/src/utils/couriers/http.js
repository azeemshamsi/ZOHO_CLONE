// Small HTTP helper for courier APIs: JSON in/out, timeouts, readable errors.
async function request(url, { method = "GET", headers = {}, json, form, raw, timeout = 30000, binary = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const h = { accept: binary ? "application/pdf, */*" : "application/json", ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    h["content-type"] = "application/x-www-form-urlencoded";
    body = typeof form === "string" ? form : new URLSearchParams(form).toString();
  } else if (raw !== undefined) body = raw;
  try {
    const r = await fetch(url, { method, headers: h, body, signal: ctrl.signal });
    if (binary && r.ok && /pdf|octet/.test(r.headers.get("content-type") || "")) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { status: r.status, data, headers: r.headers };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The courier's server didn't answer in time");
    throw new Error(`Couldn't reach the courier's server: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(t);
  }
}

const short = (d) => (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 400);

module.exports = { request, short };
