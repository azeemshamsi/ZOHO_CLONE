/**
 * Read a bill with Google Gemini: works on scanned PDFs, phone photos and messy layouts.
 * Uses the company's own Gemini API key (Settings → Integrations) or GEMINI_API_KEY on the server.
 * Returns the same shape as utils/billparse.js parseBill(), plus `lines`.
 */
const { HttpError } = require("./http");
const { snapRate, round2 } = require("./import/common");
const { STATES } = require("./states");

const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];

const num = { type: "NUMBER" };
const str = { type: "STRING" };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    isBill: { type: "BOOLEAN", description: "true if this is a tax invoice, bill, receipt or credit note from a supplier" },
    documentType: { type: "STRING", enum: ["tax_invoice", "bill_of_supply", "receipt", "credit_note", "debit_note", "other"] },
    supplierName: str,
    supplierGstin: { type: "STRING", description: "15-character GSTIN of the seller/supplier, not the buyer" },
    buyerName: str,
    buyerGstin: str,
    billNumber: { type: "STRING", description: "the supplier's invoice / bill number" },
    date: { type: "STRING", description: "invoice date as YYYY-MM-DD" },
    dueDate: { type: "STRING", description: "due date as YYYY-MM-DD, empty if none" },
    placeOfSupply: { type: "STRING", description: "Indian state of the place of supply, as written" },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: str,
          hsn: str,
          quantity: num,
          unit: str,
          taxableValue: { type: "NUMBER", description: "line value after discount, before GST" },
          gstRate: { type: "NUMBER", description: "total GST percent for the line (CGST+SGST, or IGST), e.g. 18" },
        },
        required: ["description", "taxableValue", "gstRate"],
      },
    },
    taxableTotal: num,
    cgst: num,
    sgst: num,
    igst: num,
    cess: num,
    roundOff: num,
    total: { type: "NUMBER", description: "grand total payable shown on the bill" },
    currency: str,
  },
  required: ["isBill", "supplierName", "billNumber", "date", "lines", "taxableTotal", "total"],
};

const PROMPT = `You are reading a supplier's bill for an Indian GST accounting system.
Extract the fields exactly as printed. Amounts are plain numbers in rupees without commas or symbols.
The supplier is the business that issued the bill (seller); the buyer is who it is billed to — never swap them.
Give one entry in "lines" per line item on the bill. If the bill shows only totals, give one line with the taxable total and the GST rate.
If GST is split into CGST and SGST, the line gstRate is their sum (e.g. 9% + 9% = 18).
Dates must be YYYY-MM-DD (Indian bills are day-first: 03/07/2026 is 3 July 2026).
If a value isn't on the bill, leave it empty or 0. Don't guess GSTINs.`;

const stateCode = (s) => {
  if (!s) return "";
  const m = String(s).match(/\b(\d{2})\b/);
  if (m && STATES.some(([c]) => c === m[1])) return m[1];
  const t = String(s).toLowerCase().replace(/[^a-z]/g, "");
  const hit = STATES.find(([, n]) => {
    const k = n.toLowerCase().replace(/[^a-z]/g, "");
    return k && (t.includes(k) || k.includes(t));
  });
  return hit ? hit[0] : "";
};
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const cleanGstin = (g) => {
  const x = String(g || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return GSTIN.test(x) ? x : "";
};
const ymd = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};

async function callGemini({ key, model, mime, data }) {
  const models = model ? [model, ...DEFAULT_MODELS.filter((m) => m !== model)] : DEFAULT_MODELS;
  let last;
  for (const m of models) {
    let res;
    try {
      res = await fetch(`${BASE()}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      throw new HttpError(502, `Couldn't reach Google Gemini: ${e.name === "TimeoutError" ? "it took too long" : e.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      try {
        return { out: JSON.parse(text), model: m };
      } catch {
        throw new HttpError(502, "Gemini's answer couldn't be read. Try again, or fill in the details yourself.");
      }
    }
    const msg = body.error?.message || `HTTP ${res.status}`;
    last = msg;
    if (res.status === 404) continue; // model name not available on this key → try the next
    if (res.status === 400 && /api key/i.test(msg)) throw new HttpError(400, "Gemini rejected the API key. Check it under Settings → Integrations.");
    if (res.status === 403) throw new HttpError(400, `Gemini refused the request: ${msg}. Make sure the key is from Google AI Studio and the Generative Language API is enabled.`);
    if (res.status === 429) throw new HttpError(429, "Gemini's limit for this key has been reached for now. Wait a minute and try again, or enable billing on the key in Google AI Studio.");
    throw new HttpError(502, `Gemini couldn't read the bill: ${msg}`);
  }
  throw new HttpError(502, `No Gemini model was available for this key (${last}).`);
}

/**
 * @param buf    file contents
 * @param mime   application/pdf, image/jpeg, image/png, image/webp, image/heic…
 */
async function readBillWithAI(org, buf, mime, { ownGstins = [] } = {}) {
  const key = org.ai?.geminiKey || process.env.GEMINI_API_KEY || "";
  if (!key) return null;
  const { out: o, model } = await callGemini({ key, model: org.ai?.model || process.env.GEMINI_MODEL || "", mime, data: buf.toString("base64") });
  const notes = [];
  if (o.isBill === false) notes.push("This doesn't look like a bill — check every field");
  let supplierGstin = cleanGstin(o.supplierGstin);
  let buyerGstin = cleanGstin(o.buyerGstin);
  // If the model put our own GSTIN as the supplier, swap them.
  const own = ownGstins.filter(Boolean).map((g) => g.toUpperCase());
  if (supplierGstin && own.includes(supplierGstin) && buyerGstin && !own.includes(buyerGstin)) [supplierGstin, buyerGstin] = [buyerGstin, supplierGstin];
  if (o.supplierGstin && !supplierGstin) notes.push(`Supplier GSTIN "${o.supplierGstin}" doesn't look valid`);

  const lines = (o.lines || [])
    .filter((l) => Number(l.taxableValue))
    .slice(0, 60)
    .map((l) => ({ description: String(l.description || "").slice(0, 200), hsn: String(l.hsn || "").replace(/[^0-9]/g, "").slice(0, 8), quantity: Number(l.quantity) || 1, unit: l.unit || "", taxable: round2(l.taxableValue), rate: snapRate(Number(l.gstRate) || 0) }));
  const cgst = round2(o.cgst || 0);
  const sgst = round2(o.sgst || 0);
  const igst = round2(o.igst || 0);
  const tax = round2(cgst + sgst + igst + (Number(o.cess) || 0));
  const linesTaxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const taxable = round2(o.taxableTotal || linesTaxable);
  if (lines.length && Math.abs(linesTaxable - taxable) > 1) notes.push(`Line items add up to ${linesTaxable}, the bill's taxable total is ${taxable}`);
  const total = round2(o.total || taxable + tax);
  // Rate for single-line use: the rate carrying most value, or tax ÷ taxable.
  const byRate = {};
  for (const l of lines) byRate[l.rate] = (byRate[l.rate] || 0) + l.taxable;
  const top = Object.entries(byRate).sort((a, b) => b[1] - a[1])[0];
  const rate = top ? Number(top[0]) : taxable ? snapRate((tax / taxable) * 100) : 0;
  const linesTax = lines.reduce((s, l) => s + (l.taxable * l.rate) / 100, 0);
  const adjustment = round2(total - taxable - (lines.length ? linesTax : (taxable * rate) / 100));
  if (Math.abs(adjustment) > 5) notes.push(`Total differs from taxable + GST by ${adjustment} — check for freight, cess or other charges`);
  const placeOfSupply = stateCode(o.placeOfSupply) || supplierGstin.slice(0, 2);
  return {
    ai: true,
    model,
    supplierGstin,
    buyerGstin,
    supplierName: String(o.supplierName || "").trim(),
    billNumber: String(o.billNumber || "").trim(),
    date: ymd(o.date),
    dueDate: ymd(o.dueDate),
    taxable,
    cgst,
    sgst,
    igst,
    tax,
    total,
    rate,
    adjustment: Math.abs(adjustment) <= 5 ? adjustment : 0,
    hsn: lines.find((l) => l.hsn)?.hsn || "",
    interState: igst > 0,
    placeOfSupply,
    lines,
    notes,
  };
}

// A tiny call to check a key works (Settings → Test).
async function testKey(key, model) {
  const models = model ? [model, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  for (const m of models) {
    const res = await fetch(`${BASE()}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the word OK." }] }] }),
      signal: AbortSignal.timeout(30000),
    }).catch((e) => {
      throw new HttpError(502, `Couldn't reach Google Gemini: ${e.message}`);
    });
    if (res.ok) return m;
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) continue;
    throw new HttpError(400, `Gemini said: ${body.error?.message || `HTTP ${res.status}`}`);
  }
  throw new HttpError(400, "None of the Gemini models are available for this key");
}

module.exports = { readBillWithAI, testKey };
