/**
 * Clear's GSP API (docs.cleartax.in → E-Invoicing GSP API): a pass-through to the government e-invoice system (NIC),
 * with NIC's login and encryption.
 *  - Login: POST {host}/einv-gsp/vital/v1.04/auth, headers client_id, client_secret, Gstin.
 *    Body { Data: RSA(public key, Base64(JSON{UserName, Password, AppKey, ForceRefreshAccessToken})) }
 *    → Data { AuthToken, Sek (AES-256-ECB with AppKey), TokenExpiry }.
 *  - Other calls: headers client_id, client_secret, Gstin, user_name, AuthToken; body { Data: Base64(AES-256-ECB(SEK, JSON)) };
 *    response Data encrypted with the SEK.
 * Credentials: client ID + secret and API username + password from Clear; Clear's public key (PEM) from its docs.
 */
const crypto = require("crypto");
const { request, short } = require("../couriers/http");

const HOSTS = { sandbox: "https://api-sandbox.clear.in", production: "https://api.clear.in" };
const base = (acc) => `${(acc.host || HOSTS[acc.env] || HOSTS.sandbox).replace(/\/$/, "")}/einv-gsp`;
const istDate = (s) => (s ? new Date(`${String(s).trim().replace(" ", "T")}+05:30`) : null);

const aes = (key, buf, decrypt = false) => {
  const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)("aes-256-ecb", key, null);
  return Buffer.concat([c.update(buf), c.final()]);
};
// Response Data: SEK-decrypted; some NIC calls return Base64 of the JSON, some the JSON itself.
function openData(sek, data) {
  if (data && typeof data === "object") return data;
  const plain = aes(sek, Buffer.from(String(data), "base64"), true).toString("utf8");
  try {
    return JSON.parse(plain);
  } catch {
    return JSON.parse(Buffer.from(plain, "base64").toString("utf8"));
  }
}

function errorsOf(d) {
  const lists = [d?.ErrorDetails, d?.errorDetails, d?.error?.errors, d?.errors];
  const out = [];
  for (const l of lists)
    for (const e of Array.isArray(l) ? l : l && typeof l === "object" ? [l] : []) {
      const msg = e?.ErrorMessage || e?.error_message || e?.message;
      const code = e?.ErrorCode || e?.error_code;
      if (msg) out.push(`${code ? `${code}: ` : ""}${msg}`);
    }
  if (!out.length && typeof d?.message === "string") out.push(d.message);
  if (!out.length && typeof d?.error === "string") out.push(d.error);
  return [...new Set(out)];
}

const need = (acc) => {
  const miss = [["clientId", "client ID"], ["clientSecret", "client secret"], ["username", "API username"], ["password", "API password"], ["publicKey", "Clear's public key"]].filter(([k]) => !acc[k]).map(([, l]) => l);
  if (miss.length) throw new Error(`Add the ${miss.join(", ")} in GST → e-Invoices → Clear (GSP)`);
};
const headersOf = (acc, gstin, withToken) => ({
  client_id: acc.clientId,
  client_secret: acc.clientSecret,
  Gstin: gstin,
  ...(acc.token ? { "X-CT-Auth-Token": acc.token } : {}),
  ...(withToken ? { user_name: acc.username, AuthToken: acc.authToken } : {}),
});

function check401(res) {
  if (res.status === 401 || res.status === 403) throw new Error(`Clear refused the request (${res.status}): ${errorsOf(res.data).join("; ") || short(res.data)}. Check the client ID / secret and that this GSTIN is set up with Clear.`);
  if (res.status === 404) throw new Error("Clear API address not found — check the environment (sandbox / live)");
  if (res.status >= 500) throw new Error(`Clear's server had an error (${res.status}); try again in a minute`);
}

// Log in (or reuse the session): AuthToken + SEK, valid ~6 hours (1 hour on sandbox).
async function login(acc, gstin, force = false) {
  need(acc);
  if (!force && acc.authToken && acc.sek && acc.tokenExpiry && new Date(acc.tokenExpiry) > new Date(Date.now() + 5 * 60000) && acc.tokenGstin === gstin) return acc;
  const appKey = crypto.randomBytes(32);
  const payload = Buffer.from(JSON.stringify({ UserName: acc.username, Password: acc.password, AppKey: appKey.toString("base64"), ForceRefreshAccessToken: !!force })).toString("base64");
  let enc;
  try {
    enc = crypto.publicEncrypt({ key: acc.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(payload)).toString("base64");
  } catch (e) {
    throw new Error(`Clear's public key couldn't be used (${e.message}). Paste the whole key including the BEGIN/END lines.`);
  }
  const res = await request(`${base(acc)}/vital/v1.04/auth`, { method: "POST", headers: headersOf(acc, gstin, false), json: { Data: enc }, timeout: 45000 });
  check401(res);
  const d = res.data || {};
  if (String(d.Status) !== "1" || !d.Data?.AuthToken) throw new Error(`Clear login failed: ${errorsOf(d).join("; ") || short(d)}`);
  const sek = aes(appKey, Buffer.from(d.Data.Sek, "base64"), true);
  acc.authToken = d.Data.AuthToken;
  acc.sek = sek.toString("base64");
  acc.tokenExpiry = istDate(d.Data.TokenExpiry) || new Date(Date.now() + 50 * 60000);
  acc.tokenGstin = gstin;
  if (acc.save) await acc.save();
  return acc;
}

// One encrypted call; logs in again once if the session has expired.
async function call(acc, gstin, method, path, body, { retry = true, ewb = false } = {}) {
  await login(acc, gstin);
  const sek = Buffer.from(acc.sek, "base64");
  let json;
  if (body !== undefined) {
    // E-way bill calls encrypt Base64(JSON); e-invoice calls encrypt the JSON.
    const plain = ewb ? Buffer.from(Buffer.from(JSON.stringify(body.data)).toString("base64")) : Buffer.from(JSON.stringify(body));
    const data = aes(sek, plain).toString("base64");
    json = ewb ? { action: body.action, data } : { Data: data };
  }
  const res = await request(`${base(acc)}${path}`, { method, headers: headersOf(acc, gstin, true), json, timeout: 45000 });
  const d = res.data || {};
  const errs = errorsOf(d);
  if (retry && (res.status === 401 || errs.some((e) => /^1005|auth token|token.*expired|invalid token/i.test(e)))) {
    await login(acc, gstin, true);
    return call(acc, gstin, method, path, body, { retry: false, ewb });
  }
  check401(res);
  const ok = String(d.Status ?? d.status) === "1";
  const raw = d.Data ?? d.data;
  return { ok, data: ok && raw ? openData(sek, raw) : null, errors: errs, info: d.InfoDtls || d.info || [], raw: d };
}

function irnResult(x) {
  return {
    irn: x.Irn,
    ackNo: x.AckNo ? String(x.AckNo) : "",
    ackDate: istDate(x.AckDt),
    signedInvoice: x.SignedInvoice || "",
    signedQr: x.SignedQRCode || "",
    status: x.Status,
    ewbNo: x.EwbNo ? String(x.EwbNo) : "",
    ewbDate: istDate(x.EwbDt),
    ewbValidTill: istDate(x.EwbValidTill),
  };
}

async function getByIrn(acc, gstin, irn) {
  const r = await call(acc, gstin, "GET", `/core/v1.03/Invoice/irn/${encodeURIComponent(irn)}`);
  if (r.ok && r.data) return irnResult(r.data);
  throw new Error(r.errors.join("; ") || "IRN not found");
}

async function generateIrn(acc, gstin, invJson) {
  const r = await call(acc, gstin, "POST", "/core/v1.03/Invoice", invJson);
  if (r.ok && r.data) return irnResult(r.data);
  // Already generated for this document: NIC returns the existing IRN in InfoDtls (DUPIRN).
  const dup = (r.info || []).find((i) => /DUPIRN/i.test(i.InfCd || ""));
  if (dup?.Desc?.Irn) {
    const g = await getByIrn(acc, gstin, dup.Desc.Irn).catch(() => null);
    return g || { irn: dup.Desc.Irn, ackNo: String(dup.Desc.AckNo || ""), ackDate: istDate(dup.Desc.AckDt), signedQr: "", signedInvoice: "" };
  }
  throw new Error(r.errors.join("; ") || `Clear didn't generate the IRN: ${short(r.raw)}`);
}

const CANCEL_CODE = { Duplicate: "1", "Data entry mistake": "2", "Order cancelled": "3", Others: "4" };
async function cancelIrn(acc, gstin, irn, reason, remarks) {
  const r = await call(acc, gstin, "POST", "/core/v1.03/Invoice/Cancel", { Irn: irn, CnlRsn: CANCEL_CODE[reason] || "4", CnlRem: String(remarks || reason || "Cancelled").slice(0, 100) });
  if (r.ok) return { cancelledAt: istDate(r.data?.CancelDate) || new Date() };
  throw new Error(r.errors.join("; ") || `Clear didn't cancel the IRN: ${short(r.raw)}`);
}

async function ewbByIrn(acc, gstin, irn, t) {
  const { transport } = require("./clear");
  const r = await call(acc, gstin, "POST", "/eiewb/v1.03/ewaybill", { Irn: irn, ...transport(t) });
  if (r.ok && r.data?.EwbNo) return { ewbNo: String(r.data.EwbNo), ewbDate: istDate(r.data.EwbDt), validUpto: istDate(r.data.EwbValidTill), remarks: r.data.Remarks || "" };
  throw new Error(r.errors.join("; ") || `Clear didn't generate the e-way bill: ${short(r.raw)}`);
}

async function ewbNonIrn() {
  throw new Error("E-way bills for invoices without an IRN (B2C) need Clear's separate e-way bill API credentials. For these, use Download JSON on the e-way bill portal, or ask Clear for e-way bill API access.");
}

const EWB_CANCEL = { Duplicate: 1, "Data entry mistake": 2, "Order cancelled": 3, Others: 4 };
async function cancelEwb(acc, gstin, ewbNo, reason, remarks) {
  const r = await call(acc, gstin, "POST", "/ewb/v1.03/ewayapi", { action: "CANEWB", data: { ewbNo: Number(ewbNo), cancelRsnCode: EWB_CANCEL[reason] || 4, cancelRmrk: String(remarks || reason || "Cancelled").slice(0, 50) } }, { ewb: true });
  if (r.ok) return { cancelledAt: new Date() };
  throw new Error(r.errors.join("; ") || `Clear didn't cancel the e-way bill: ${short(r.raw)}`);
}

// Connection check = a fresh login.
async function check(acc, gstin) {
  await login(acc, gstin, true);
  return { ok: true, note: `Logged in as ${acc.username}` };
}

module.exports = { HOSTS, login, call, generateIrn, getByIrn, cancelIrn, ewbByIrn, ewbNonIrn, cancelEwb, check, openData, aes };
