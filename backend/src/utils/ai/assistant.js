/**
 * "Ask OrdexaGo": questions in plain words answered from the company's own books, orders and stock.
 * Gemini picks tools; each tool is a read-only GET on OrdexaGo's own API, made as the asking user (their login
 * and company), so the assistant sees exactly what that user is allowed to see — nothing more — and can't change
 * anything.
 */
const env = require("../../config/env");
const { chat } = require("./gemini");

const S = { type: "string" };
const DATE = { type: "string", description: "YYYY-MM-DD" };
const range = { from: DATE, to: DATE };

// name → [description, params, path builder]
const TOOLS = [
  ["dashboard", "Home dashboard: cash & bank balances, receivables and payables (total, overdue, ageing), sales and expenses by month for the last 12 months, counts. Good first look for general questions.", {}, () => "/dashboard"],
  ["profit_and_loss", "Profit & Loss for a date range: income, cost of goods sold, gross profit, expenses by ledger, net profit (Tally view, with opening/closing stock).", range, (a) => `/reports/profit-and-loss?view=tally&${qs(a, ["from", "to"])}`],
  ["balance_sheet", "Balance sheet as on a date (assets, liabilities, equity).", { to: DATE }, (a) => `/reports/balance-sheet?${qs(a, ["to"])}`],
  ["receivables_by_customer", "Money customers owe us, per customer, with ageing buckets (current, 1-30, 31-60…) and advances. Use for 'who owes', 'dues', 'overdue customers', a marketplace's dues (Amazon, Flipkart… are customers).", {}, () => "/reports/ar-aging"],
  ["payables_by_vendor", "Money we owe vendors, per vendor, with ageing buckets. Use for 'what do we owe', 'vendor dues'.", {}, () => "/reports/ap-aging"],
  ["sales_by_customer", "Sales (invoiced) per customer for a date range.", range, (a) => `/reports/sales-by-customer?${qs(a, ["from", "to"])}`],
  ["sales_by_item", "Sales per item (quantity and amount) for a date range: best sellers, slow movers.", range, (a) => `/reports/sales-by-item?${qs(a, ["from", "to"])}`],
  ["expenses_by_category", "Expenses per ledger / category for a date range.", range, (a) => `/reports/expenses-by-category?${qs(a, ["from", "to"])}`],
  ["gst_summary", "GSTR-3B style GST summary for a date range: output tax, input tax credit, tax payable.", range, (a) => `/reports/gstr3b?${qs(a, ["from", "to"])}`],
  ["bank_accounts", "Cash and bank accounts with book balance and imported-statement status (unmatched lines, last statement balance).", {}, () => "/banking/accounts"],
  ["find_customers", "Search customers by name, phone, email or GSTIN; returns their details and balances.", { q: S }, (a) => `/customers?${qs(a, ["q"])}`],
  ["find_vendors", "Search vendors by name, phone, email or GSTIN; returns their details and balances.", { q: S }, (a) => `/vendors?${qs(a, ["q"])}`],
  ["find_items", "Search items / products by name or SKU: price, cost, stock on hand, HSN, GST rate.", { q: S }, (a) => `/items?${qs(a, ["q"])}`],
  ["stock", "Stock on hand per item (and racks / warehouses), searchable by name or SKU.", { q: S }, (a) => `/stock?${qs(a, ["q"])}`],
  ["invoices", "Sales invoices; filter with q (number / customer name) and status (draft, sent, paid, partially_paid, overdue, void). open=true for unpaid only.", { q: S, status: S, open: { type: "boolean" } }, (a) => `/invoices?${qs(a, ["q", "status", "open"])}`],
  ["bills", "Purchase bills; filter with q (number / vendor name) and status (open, paid, partially_paid, overdue, void). open=true for unpaid only.", { q: S, status: S, open: { type: "boolean" } }, (a) => `/bills?${qs(a, ["q", "status", "open"])}`],
  ["expenses", "Recorded expenses; filter with q (text) and category.", { q: S, category: S }, (a) => `/expenses?${qs(a, ["q", "category"])}`],
  [
    "store_orders",
    "Online store (Shopify) orders: returns counts per status (new, packed, ready_to_ship, shipped, delivered, rto, return_created, returned, cancelled) for the filters, plus up to 50 orders. Filters: from/to (order date), status, courier, channel, payment (cod / prepaid), q (order no., customer, phone, AWB). Use for RTO rates, pending dispatch, COD vs prepaid, an order's status.",
    { ...range, status: S, courier: S, channel: S, payment: S, q: S },
    (a) => `/shopify/orders?limit=50&${qs(a, ["from", "to", "status", "courier", "channel", "payment", "q"])}`,
  ],
];

function qs(a, keys) {
  const p = new URLSearchParams();
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== "") p.set(k, String(a[k]));
  return p.toString();
}

// Keep tool results small enough for the model: long lists cut, long text cut, heavy fields dropped.
const DROP = new Set(["__v", "organization", "createdBy", "updatedBy", "attachments", "history", "lines_raw", "raw", "logo", "signature", "image", "images", "html", "pdf", "activity", "comments"]);
function compact(v, depth = 0) {
  if (Array.isArray(v)) {
    const max = depth === 0 ? 60 : 25;
    const out = v.slice(0, max).map((x) => compact(x, depth + 1));
    if (v.length > max) out.push(`… ${v.length - max} more not shown`);
    return out;
  }
  if (v && typeof v === "object") {
    if (depth > 5) return "[…]";
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.has(k) || x === null || x === "" || (Array.isArray(x) && !x.length)) continue;
      o[k] = compact(x, depth + 1);
    }
    return o;
  }
  if (typeof v === "string" && v.length > 300) return `${v.slice(0, 300)}…`;
  return v;
}

function toolsFor(req) {
  const headers = { authorization: req.headers.authorization || "", "x-org": String(req.org), accept: "application/json" };
  return TOOLS.map(([name, description, props, path]) => ({
    name,
    description,
    parameters: Object.keys(props).length ? { type: "object", properties: props } : undefined,
    run: async (args) => {
      const res = await fetch(`http://127.0.0.1:${env.PORT}/api${path(args)}`, { headers, signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 403) return { error: "This user's role doesn't allow seeing this — say so instead of guessing." };
      if (!res.ok) return { error: body.message || `HTTP ${res.status}` };
      let out = JSON.stringify(compact(body));
      if (out.length > 30000) out = `${out.slice(0, 30000)}… (cut)`;
      return out;
    },
  }));
}

function systemPrompt(req, orgName) {
  const now = new Date(Date.now() + 5.5 * 3600000);
  const today = now.toISOString().slice(0, 10);
  const fyStart = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `You are OrdexaGo's assistant for ${orgName}, an Indian business (accounts, GST, inventory, online store orders).
Today is ${today} (IST). The financial year runs April–March; this FY started ${fyStart}-04-01. Currency is INR.
Answer the user's question using ONLY data from the tools — call them; never guess or invent numbers. If a tool errors or the data isn't there, say so plainly.
Work out date ranges yourself ("this month", "last quarter", "Diwali week", "this FY") and pass them as YYYY-MM-DD.
Keep answers short and direct: lead with the answer, then a few supporting lines. Write amounts like ₹1,23,456 (Indian grouping). Use a small markdown table only when comparing several rows. Mention which report/data you used in a few words at the end, e.g. "(from Profit & Loss, 1–30 Nov)".
Reply in the user's language (English, Hindi or Hinglish as they wrote).
You can only read data. If asked to create, change, delete or send something, explain where in OrdexaGo they can do it.
The user is ${req.user?.name || "a user"} (role: ${req.roleInfo?.label || req.user?.role || "user"}).`;
}

async function answer(req, org, history) {
  return chat(org, { system: systemPrompt(req, org.name || "the company"), history, tools: toolsFor(req) });
}

module.exports = { answer, compact, toolsFor };
