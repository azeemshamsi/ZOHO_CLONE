/**
 * Clear (ClearTax) GSP: e-invoice IRN, e-way bills. Government-schema APIs, so the e-invoice JSON is the
 * same INV-01 JSON OrdexaGo builds for the IRP upload (utils/einvoice.js).
 * Docs: docs.cleartax.in → E-invoicing API → Government Schema; E-waybill APIs.
 */
const { request, short } = require("../couriers/http");

const HOSTS = { sandbox: "https://api-sandbox.clear.in", production: "https://api.clear.in" };
const hostOf = (acc) => (acc.host || HOSTS[acc.env] || HOSTS.sandbox).replace(/\/$/, "");
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Clear's dates are "YYYY-MM-DD HH:MM:SS" in IST.
const istDate = (s) => (s ? new Date(`${String(s).trim().replace(" ", "T")}+05:30`) : null);

async function call(acc, gstin, method, path, body, { einv = true } = {}) {
  if (!acc?.token) throw new Error("Add the Clear auth token in GST → Clear (GSP) settings");
  if (!gstin) throw new Error("Set the GSTIN for Clear (or the company's GSTIN)");
  const headers = { "x-cleartax-auth-token": acc.token, gstin };
  if (einv) headers["x-cleartax-product"] = "EInvoice";
  const res = await request(`${hostOf(acc)}${path}`, { method, headers, json: body, timeout: 45000 });
  if (res.status === 401 || res.status === 403) throw new Error(`Clear refused the auth token (${res.status}). Check the token, the environment (test/live), and that GSTIN ${gstin} is in that Clear workspace.`);
  if (res.status >= 500) throw new Error(`Clear's server had an error (${res.status}); try again in a minute`);
  if (res.status === 404) throw new Error(`Clear API address not found (${hostOf(acc)}${path}). Check the environment / API address in the settings.`);
  return res.data;
}

// Error messages from any of Clear's response shapes.
function errorsOf(d) {
  const lists = [d?.ErrorDetails, d?.errorDetails, d?.errors?.errors, d?.errors, d?.govt_response?.ErrorDetails, d?.error?.errors];
  const out = [];
  for (const l of lists) for (const e of Array.isArray(l) ? l : l && typeof l === "object" ? [l] : []) if (e && (e.error_message || e.ErrorMessage || e.message)) out.push(`${e.error_code ? `${e.error_code}: ` : ""}${e.error_message || e.ErrorMessage || e.message}`);
  if (!out.length && typeof d?.message === "string") out.push(d.message);
  return [...new Set(out)];
}
const unwrap = (d) => (Array.isArray(d) ? d[0] : d?.govt_response ? { ...d, ...d.govt_response } : d) || {};

function irnResult(d) {
  return {
    irn: d.Irn,
    ackNo: d.AckNo ? String(d.AckNo) : "",
    ackDate: istDate(d.AckDt),
    signedInvoice: d.SignedInvoice || "",
    signedQr: d.SignedQRCode || "",
    status: d.Status,
    ewbNo: d.EwbNo ? String(d.EwbNo) : "",
    ewbDate: istDate(d.EwbDt),
    ewbValidTill: istDate(d.EwbValidTill),
  };
}

async function getByIrn(acc, gstin, irn) {
  const d = unwrap(await call(acc, gstin, "GET", `/einv/v1/govt/api/Invoice/irn/${encodeURIComponent(irn)}`));
  if (d.Success === "Y" || d.Irn) return irnResult(d);
  throw new Error(errorsOf(d).join("; ") || "IRN not found");
}

// Generate the IRN. If it already exists (DUPIRN), Clear returns the existing details: use them.
async function generateIrn(acc, gstin, invJson) {
  const d = unwrap(await call(acc, gstin, "POST", "/einv/v1/govt/api/Invoice/", invJson));
  if (d.Success === "Y" || d.Irn) return irnResult(d);
  const dup = (d.Info || []).find((i) => /DUPIRN/i.test(i.InfCd || ""));
  if (dup?.Desc && typeof dup.Desc === "object" && dup.Desc.Irn) {
    const g = await getByIrn(acc, gstin, dup.Desc.Irn).catch(() => null);
    return g || { irn: dup.Desc.Irn, ackNo: String(dup.Desc.AckNo || ""), ackDate: istDate(dup.Desc.AckDt), signedQr: "", signedInvoice: "" };
  }
  throw new Error(errorsOf(d).join("; ") || `Clear didn't generate the IRN: ${short(d)}`);
}

const CANCEL_CODE = { Duplicate: "1", "Data entry mistake": "2", "Order cancelled": "3", Others: "4" };
async function cancelIrn(acc, gstin, irn, reason, remarks) {
  const d = unwrap(await call(acc, gstin, "POST", "/einv/v1/govt/api/Cancel", { irn, CnlRsn: CANCEL_CODE[reason] || "4", CnlRem: String(remarks || reason || "Cancelled").slice(0, 100) }));
  if (d.Success === "Y") return { cancelledAt: istDate(d.CancelDate) || new Date() };
  throw new Error(errorsOf(d).join("; ") || `Clear didn't cancel the IRN: ${short(d)}`);
}

const dmyOf = (d) => {
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
};
// Transport fields for both e-way bill calls: only what's filled in. Distance 0 = Clear works it out from the PINs.
// No vehicle / transporter = Part A only (Part B added later on the portal).
function transport(t = {}) {
  const out = { Distance: Number(t.distance) || 0 };
  const mode = String(t.transMode || "1");
  if (t.transporterId) out.TransId = String(t.transporterId).toUpperCase();
  if (t.transporterName) out.TransName = t.transporterName;
  if (t.transDocNo) {
    out.TransDocNo = t.transDocNo;
    out.TransMode = mode;
  }
  if (t.transDocDate) out.TransDocDt = dmyOf(t.transDocDate);
  if (t.vehicleNo) {
    out.VehNo = String(t.vehicleNo).replace(/[\s-]/g, "").toUpperCase();
    out.VehType = t.vehicleType === "O" ? "O" : "R";
    out.TransMode = mode;
  }
  return out;
}

async function ewbByIrn(acc, gstin, irn, t) {
  const d = unwrap(await call(acc, gstin, "POST", "/einv/v1/govt/api/einvewb/ewaybill", { Irn: irn, ...transport(t) }));
  if (d.Success === "Y" && d.EwbNo) return { ewbNo: String(d.EwbNo), ewbDate: istDate(d.EwbDt), validUpto: istDate(d.EwbValidTill), remarks: d.Remarks || "" };
  throw new Error(errorsOf(d).join("; ") || `Clear didn't generate the e-way bill: ${short(d)}`);
}

// E-way bill for an invoice without an IRN (e.g. B2C), from OrdexaGo's e-way bill JSON (buildEwayBill).
function nonIrnBody(bill, t) {
  const st = (n) => String(n || "").padStart(2, "0");
  const ItemList = bill.itemList.map((l) => ({
    ProdName: l.productName,
    ProdDesc: l.productDesc,
    HsnCd: String(l.hsnCode),
    Qty: l.quantity,
    Unit: l.qtyUnit,
    AssAmt: l.taxableAmount,
    CgstRt: l.cgstRate,
    CgstAmt: r2((l.taxableAmount * l.cgstRate) / 100),
    SgstRt: l.sgstRate,
    SgstAmt: r2((l.taxableAmount * l.sgstRate) / 100),
    IgstRt: l.igstRate,
    IgstAmt: r2((l.taxableAmount * l.igstRate) / 100),
    CesRt: 0,
    CesAmt: 0,
    OthChrg: 0,
    CesNonAdvAmt: 0,
  }));
  return {
    DocumentNumber: bill.docNo,
    DocumentType: "INV",
    DocumentDate: bill.docDate,
    SupplyType: "Outward",
    SubSupplyType: String(bill.subSupplyType || 1),
    TransactionType: "1",
    SellerDtls: { Gstin: bill.fromGstin, LglNm: bill.fromTrdName, TrdNm: bill.fromTrdName, Addr1: bill.fromAddr1 || bill.fromPlace, Loc: bill.fromPlace, Pin: bill.fromPincode, Stcd: st(bill.fromStateCode) },
    BuyerDtls: { Gstin: bill.toGstin || "URP", LglNm: bill.toTrdName, TrdNm: bill.toTrdName, Addr1: bill.toAddr1 || bill.toPlace, Loc: bill.toPlace, Pin: bill.toPincode, Stcd: st(bill.toStateCode) },
    ExpShipDtls: { LglNm: bill.toTrdName, Addr1: bill.toAddr1 || bill.toPlace, Loc: bill.toPlace, Pin: bill.toPincode, Stcd: st(bill.actToStateCode || bill.toStateCode) },
    ItemList,
    TotalInvoiceAmount: bill.totInvValue,
    TotalCgstAmount: bill.cgstValue,
    TotalSgstAmount: bill.sgstValue,
    TotalIgstAmount: bill.igstValue,
    TotalCessAmount: 0,
    TotalCessNonAdvolAmount: 0,
    TotalAssessableAmount: bill.totalValue,
    OtherAmount: bill.otherValue,
    OtherTcsAmount: 0,
    ...transport(t),
  };
}
async function ewbNonIrn(acc, gstin, bill, t) {
  const d = unwrap(await call(acc, gstin, "PUT", "/einv/v3/ewaybill/generate", nonIrnBody(bill, t), { einv: false }));
  if (d.Success === "Y" && d.EwbNo) return { ewbNo: String(d.EwbNo), ewbDate: istDate(d.EwbDt), validUpto: istDate(d.EwbValidTill), remarks: d.Alert || "" };
  throw new Error(errorsOf(d).join("; ") || `Clear didn't generate the e-way bill: ${short(d)}`);
}

const EWB_CANCEL = { Duplicate: "DUPLICATE", "Data entry mistake": "DATA_ENTRY_MISTAKE", "Order cancelled": "ORDER_CANCELLED", Others: "OTHERS" };
async function cancelEwb(acc, gstin, ewbNo, reason, remarks) {
  const d = await call(acc, gstin, "POST", "/einv/v2/eInvoice/ewaybill/cancel", { ewbNo: Number(ewbNo), cancelRsnCode: EWB_CANCEL[reason] || "OTHERS", cancelRmrk: String(remarks || reason || "Cancelled").slice(0, 50) }, { einv: false });
  if (d?.ewbStatus === "CANCELLED") return { cancelledAt: new Date() };
  throw new Error(errorsOf(d).join("; ") || `Clear didn't cancel the e-way bill: ${short(d)}`);
}

// Connection check: look up an IRN that can't exist. Clear answering (with "not found") means the token works.
async function check(acc, gstin) {
  const d = unwrap(await call(acc, gstin, "GET", `/einv/v1/govt/api/Invoice/irn/${"0".repeat(64)}`));
  return { ok: true, note: errorsOf(d)[0] || "" };
}

// Two ways to connect: Clear's auth token (E-Invoicing API), or client ID/secret + API username/password
// (E-Invoicing GSP API, NIC login and encryption — utils/gsp/clearGsp.js).
const byToken = { generateIrn, getByIrn, cancelIrn, ewbByIrn, ewbNonIrn, cancelEwb, check };
const pick = (name) => (acc, ...args) => (acc?.mode === "gsp" ? require("./clearGsp")[name] : byToken[name])(acc, ...args);

module.exports = {
  HOSTS,
  hostOf,
  generateIrn: pick("generateIrn"),
  getByIrn: pick("getByIrn"),
  cancelIrn: pick("cancelIrn"),
  ewbByIrn: pick("ewbByIrn"),
  ewbNonIrn: pick("ewbNonIrn"),
  cancelEwb: pick("cancelEwb"),
  check: pick("check"),
  nonIrnBody,
  transport,
  errorsOf,
  CANCEL_REASONS: Object.keys(CANCEL_CODE),
};
