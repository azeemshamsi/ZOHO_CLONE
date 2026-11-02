/**
 * Import from Zoho Books, Tally ERP / TallyPrime, or any spreadsheet.
 *   POST /preview   {fileName, data(base64), type?, side?}  → what was found (nothing is saved yet)
 *   POST /commit    {id, openingDate?}                       → starts the import, returns a job id
 *   GET  /jobs/:id                                           → progress and results
 *   GET  /templates/:type                                    → CSV template
 */
const router = require("express").Router();
const crypto = require("crypto");
const { ah, HttpError } = require("../utils/http");
const { parseFile } = require("../utils/import/parse");
const sheets = require("../utils/import/sheets");
const tally = require("../utils/import/tally");
const { commit } = require("../utils/import/commit");
const { iso, key } = require("../utils/import/common");

const TTL = 60 * 60 * 1000;
const previews = new Map(); // id → {org, data, at}
const jobs = new Map(); // id → {org, status, done, total, results, warnings, error}
setInterval(() => {
  const now = Date.now();
  for (const m of [previews, jobs]) for (const [k, v] of m) if (now - v.at > TTL) m.delete(k);
}, 10 * 60 * 1000).unref();

const LABELS = {
  accounts: "Chart of accounts",
  customers: "Customers (debtors)",
  vendors: "Vendors (creditors)",
  openingBalances: "Opening balances",
  invoices: "Invoices",
  bills: "Bills",
  creditNotes: "Credit notes",
  vendorCredits: "Vendor credits / debit notes",
  payments: "Customer payments (receipts)",
  vendorPayments: "Vendor payments",
  expenses: "Expenses",
  journals: "Journals",
  stockAdjustments: "Stock journals / manufacturing (inventory adjustments)",
  openingStock: "Opening stock (items)",
};
const TYPES = Object.keys(LABELS);

function emptyRecords() {
  return Object.fromEntries(TYPES.map((t) => [t, []]));
}

function sample(type, r) {
  switch (type) {
    case "accounts":
      return { Name: r.name, Code: r.code, Group: r.group || "?", "Opening (Dr+/Cr−)": r.opening || "" };
    case "customers":
    case "vendors":
      return { Name: r.displayName, GSTIN: r.gstin, State: r.placeOfSupply, Email: r.email, Opening: r.opening || "", "Bill-wise": (r.openingBills || []).length || "" };
    case "openingBalances":
      return { Account: r.account, Debit: r.debit, Credit: r.credit };
    case "invoices":
    case "bills":
    case "creditNotes":
    case "vendorCredits":
      return { Number: r.number, Date: iso(r.date), Party: r.party, Lines: r.lines.length, Total: r.total, Status: r.status };
    case "openingStock":
      return { Item: r.name, Quantity: r.quantity, Rate: r.rate, Value: r.value };
    case "stockAdjustments":
      return { Number: r.number, Date: iso(r.date), Type: r.reason, In: r.lines.filter((l) => l.quantity > 0).map((l) => `${l.quantity} ${l.unit} ${l.name}`).join(", ").slice(0, 80), Out: r.lines.filter((l) => l.quantity < 0).map((l) => `${-l.quantity} ${l.unit} ${l.name}`).join(", ").slice(0, 80) };
    case "payments":
    case "vendorPayments":
      return { Number: r.number, Date: iso(r.date), Party: r.party, Amount: r.amount, Against: (r.allocations || []).map((a) => a.number).join(", ") };
    case "expenses":
      return { Date: iso(r.date), Account: r.account, Amount: r.amount, "Paid through": r.paidThrough, Vendor: r.vendor };
    case "journals":
      return { Number: r.number, Date: iso(r.date), Lines: r.lines.length, Amount: r.lines.reduce((s, l) => s + l.debit, 0) };
    default:
      return r;
  }
}

router.post(
  "/preview",
  ah(async (req, res) => {
    const { fileName, data, type, side, gzip } = req.body || {};
    if (!fileName || !data) throw new HttpError(400, "Choose a file to import");
    let buf = Buffer.from(String(data).replace(/^data:.*?;base64,/, ""), "base64");
    if (gzip) {
      try {
        buf = require("zlib").gunzipSync(buf, { maxOutputLength: 200 * 1024 * 1024 });
      } catch (e) {
        throw new HttpError(400, /maxOutputLength|buffer/i.test(e.message) ? "The file is larger than 200 MB. Split it by date range." : "The upload was damaged — try again");
      }
    }
    if (!buf.length) throw new HttpError(400, "The file is empty");
    // Tally Stock Summary (Excel) → opening stock per item
    const SS = require("../utils/import/stockSummary");
    if (/\.xlsx?$/i.test(fileName) && SS.isStockSummary(buf)) {
      let ss;
      try {
        ss = SS.parseStockSummary(buf);
      } catch (e) {
        throw new HttpError(400, `Couldn't read this Stock Summary: ${e.message}`);
      }
      if (!ss.items.length) throw new HttpError(400, "No stock items with a quantity were found in this Stock Summary. Export it with all levels expanded (Alt+F5).");
      const records = emptyRecords();
      records.openingStock = ss.items;
      const id = crypto.randomUUID();
      const next = ss.asOn ? new Date(ss.asOn.getTime() + 86400000) : null;
      const warnings = [...ss.warnings, `Stock as on ${ss.asOn ? iso(ss.asOn) : "?"}: ${ss.items.length} items worth ₹${ss.items.reduce((t, i) => t + i.value, 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}. It becomes each item's opening stock on the opening date below.`];
      previews.set(id, { org: String(req.org), at: Date.now(), data: { source: "tally", records, ledgerGroup: null, warnings } });
      return res.send({ id, source: "tally", fileName, sheets: ["Stock Summary"], datasets: [{ type: "openingStock", label: LABELS.openingStock, count: ss.items.length, sample: ss.items.slice(0, 5).map((r) => sample("openingStock", r)) }], warnings, hasOpening: true, firstDate: next ? iso(next) : null, openingDefault: next ? iso(next) : null });
    }
    let parsed;
    try {
      parsed = parseFile(fileName, buf);
    } catch (e) {
      throw new HttpError(400, `Couldn't read this file: ${e.message}`);
    }
    const records = emptyRecords();
    const warnings = [];
    let source = "sheet";
    let ledgerGroup = null;
    const sheetsFound = [];

    if (parsed.format === "xml") {
      if (!tally.isTally(parsed.xml)) throw new HttpError(400, "This XML isn't a Tally export. Export from Tally with Format = XML (Data Interchange), or use Excel/CSV.");
      source = "tally";
      // Ledgers already in OrdexaGo (from an earlier masters import) tell us who is a customer/vendor.
      const Customer = require("../models/Customer");
      const Vendor = require("../models/Vendor");
      const { chartOfAccounts } = require("../utils/ledger");
      const known = {};
      for (const a of await chartOfAccounts(req.org)) known[a.name.toLowerCase()] = a.group;
      for (const c of await Customer.find({ organization: req.org }, { displayName: 1 }).lean()) known[c.displayName.toLowerCase()] = "debtors";
      for (const v of await Vendor.find({ organization: req.org }, { displayName: 1 }).lean()) known[v.displayName.toLowerCase()] = "creditors";
      const out = tally.normalise(parsed.xml, { ledgers: known });
      Object.assign(records, out.records);
      ledgerGroup = out.ledgerGroup;
      warnings.push(...out.warnings);
    } else {
      for (const sh of parsed.sheets) {
        if (!sh.rows.length) continue;
        const headers = Object.keys(sh.rows[0]);
        let t = type && TYPES.includes(type) && parsed.sheets.length === 1 ? type : sheets.detect(headers.map(key), sh.name === "Sheet1" ? fileName : `${sh.name} ${fileName}`);
        if ((t === "customers" || t === "vendors") && (side === "customer" || side === "vendor")) t = `${side}s`;
        if (!t) {
          warnings.push(`Sheet "${sh.name}": couldn't tell what this contains (columns: ${headers.slice(0, 8).join(", ")}). Pick the type and preview again.`);
          continue;
        }
        const out = sheets.NORMALISE[t](sh.rows, { fileName });
        const recs = out.records || out;
        if (out.warnings) warnings.push(...out.warnings.map((w) => `${sh.name}: ${w}`));
        // Contacts files can hold both sides (Zoho "Contacts" export has a Contact Type column)
        // Ledger lists (Tally "List of Ledgers", trial balances) carry debtors and creditors too: make them contacts.
        if (t === "accounts") {
          for (const a of recs.filter((x) => x.group === "debtors" || x.group === "creditors")) {
            const kind = a.group === "debtors" ? "customer" : "vendor";
            records[`${kind}s`].push({ kind, displayName: a.name, companyName: "", email: "", phone: "", gstTreatment: "consumer", gstin: "", placeOfSupply: "", billingAddress: {}, paymentTerms: null, currency: "", opening: kind === "customer" ? a.opening : -a.opening });
          }
          records.accounts.push(...recs.filter((x) => x.group !== "debtors" && x.group !== "creditors"));
        } else if (recs.customers || recs.vendors) {
          for (const k of Object.keys(recs)) records[k].push(...recs[k]);
        } else records[t].push(...recs);
        sheetsFound.push({ sheet: sh.name, type: t, rows: sh.rows.length });
        if (headers.some((h) => /zoho|^(invoice|bill|payment|journal) id$|^contact id$|^account id$/i.test(h))) source = "zoho";
      }
    }
    const datasets = TYPES.filter((t) => records[t].length).map((t) => ({ type: t, label: LABELS[t], count: records[t].length, sample: records[t].slice(0, 5).map((r) => sample(t, r)) }));
    if (!datasets.length) throw new HttpError(400, warnings[0] || "Nothing to import was found in this file");
    const hasOpening = records.accounts.some((a) => a.opening) || records.openingBalances.length || [...records.customers, ...records.vendors].some((c) => c.opening || (c.openingBills || []).length);
    const dates = TYPES.flatMap((t) => records[t].map((r) => r.date)).filter(Boolean);
    const first = dates.length ? new Date(Math.min(...dates.map((d) => +d))) : null;
    const id = crypto.randomUUID();
    previews.set(id, { org: String(req.org), at: Date.now(), data: { source, records, ledgerGroup, warnings } });
    res.send({ id, source, fileName, sheets: sheetsFound, datasets, warnings: [...new Set(warnings)].slice(0, 100), hasOpening, firstDate: first ? iso(first) : null });
  })
);

router.post(
  "/commit",
  ah(async (req, res) => {
    const p = previews.get(req.body?.id);
    if (!p || p.org !== String(req.org)) throw new HttpError(400, "This preview has expired — upload the file again");
    const openingDate = req.body.openingDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.openingDate) ? req.body.openingDate : null;
    const total = Object.values(p.data.records).reduce((s, a) => s + a.length, 0) + 1;
    const jobId = crypto.randomUUID();
    const job = { org: String(req.org), at: Date.now(), status: "running", done: 0, total, results: null, warnings: [], error: null };
    jobs.set(jobId, job);
    previews.delete(req.body.id);
    commit({ org: req.org, user: req.user }, p.data, { openingDate }, () => {
      job.done = Math.min(job.done + 1, total);
    })
      .then((out) => Object.assign(job, { status: "done", done: total, results: out.results, warnings: out.warnings }))
      .catch((e) => Object.assign(job, { status: "failed", error: e.message }));
    res.send({ jobId });
  })
);

router.get(
  "/jobs/:id",
  ah(async (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.org !== String(req.org)) throw new HttpError(404, "Import not found");
    const { org, at, ...rest } = j;
    res.send({ ...rest, labels: LABELS });
  })
);

const TEMPLATES = {
  accounts: ["Account Name,Account Code,Account Type,Description,Opening Balance", "Office Rent,6001,Expense,,", "HDFC Current A/c,1201,Bank,,250000", "Unsecured Loan - Mr A,2501,Long Term Liability,,-100000"],
  customers: ["Display Name,Company Name,Email,Phone,GSTIN,GST Treatment,Place of Supply,Billing Address,Billing City,Billing State,Billing Code,Payment Terms,Opening Balance", "Acme Traders,Acme Traders Pvt Ltd,accounts@acme.in,9800000000,27AABCA1234A1Z5,Registered Business - Regular,MH,12 MG Road,Mumbai,Maharashtra,400001,30,15000"],
  vendors: ["Display Name,Company Name,Email,Phone,GSTIN,GST Treatment,Place of Supply,Billing Address,Billing City,Billing State,Billing Code,Payment Terms,Opening Balance", "Shree Suppliers,Shree Suppliers,,9811111111,29AAACS1234B1Z2,Registered Business - Regular,KA,,Bengaluru,Karnataka,560001,15,5000 Cr"],
  openingBalances: ["Account Name,Debit,Credit", "HDFC Current A/c,250000,", "Capital Account,,250000"],
  invoices: ["Invoice Number,Invoice Date,Due Date,Customer Name,Place of Supply,Item Name,HSN/SAC,Quantity,Item Price,Discount(%),Item Tax %,Total", "INV-001,01/04/2026,01/05/2026,Acme Traders,MH,Widget,8471,2,1000,0,18,2360", "INV-001,01/04/2026,01/05/2026,Acme Traders,MH,Installation,998713,1,500,0,18,"],
  bills: ["Bill Number,Bill Date,Due Date,Vendor Name,Place of Supply,Item Name,HSN/SAC,Quantity,Rate,Item Tax %,Total", "SS/101,02/04/2026,17/04/2026,Shree Suppliers,KA,Raw material,7208,10,250,18,2950"],
  creditNotes: ["Credit Note Number,Credit Note Date,Customer Name,Invoice Number,Item Name,Quantity,Item Price,Item Tax %,Total", "CN-001,10/04/2026,Acme Traders,INV-001,Widget,1,1000,18,1180"],
  vendorCredits: ["Vendor Credit Number,Vendor Credit Date,Vendor Name,Bill Number,Item Name,Quantity,Rate,Item Tax %,Total", "DN-001,12/04/2026,Shree Suppliers,SS/101,Raw material,1,250,18,295"],
  payments: ["Payment Number,Date,Customer Name,Amount,Mode,Deposit To,Reference Number,Invoice Number,Amount Applied", "1,15/04/2026,Acme Traders,1180,Bank Transfer,HDFC Current A/c,UTR123,INV-001,1180"],
  vendorPayments: ["Payment Number,Date,Vendor Name,Amount,Mode,Paid Through,Reference Number,Bill Number,Amount Applied", "1,20/04/2026,Shree Suppliers,2655,Cheque,HDFC Current A/c,000123,SS/101,2655"],
  expenses: ["Expense Date,Expense Account,Amount,Tax %,Paid Through,Vendor Name,Reference#,Notes", "05/04/2026,Office Rent,25000,18,HDFC Current A/c,,APR-RENT,April rent"],
  journals: ["Journal Number,Journal Date,Account,Debit,Credit,Notes", "JV-1,30/04/2026,Depreciation,5000,,Monthly depreciation", "JV-1,30/04/2026,Accumulated Depreciation,,5000,"],
};
router.get("/templates/:type", (req, res) => {
  const t = TEMPLATES[req.params.type];
  if (!t) return res.status(404).send({ message: "No such template" });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ordexago-${req.params.type}-template.csv"`);
  res.send("﻿" + t.join("\r\n") + "\r\n");
});

/**
 * Undo an import of transactions: deletes the invoices, bills, notes, payments, expenses and journals
 * that came from a given source (Tally / Zoho / spreadsheet) in a date range. Customers, vendors,
 * accounts and opening balances stay. Deletion goes through the normal routes, so stock and
 * balances are reversed exactly as if each were deleted by hand.
 *   GET  /undo?source=tally&from=&to=   → what would be deleted
 *   POST /undo {source, from, to}       → delete
 */
const UNDO = [
  // payments first so invoices/bills are free to delete
  ["payments", "Payment", "/payments", "paymentNumber"],
  ["vendorPayments", "VendorPayment", "/vendor-payments", "paymentNumber"],
  ["creditNotes", "CreditNote", "/credit-notes", "number"],
  ["vendorCredits", "VendorCredit", "/vendor-credits", "number"],
  ["expenses", "Expense", "/expenses", "reference"],
  ["journals", "Journal", "/journals", "number"],
  ["stockAdjustments", "InventoryAdjustment", "/inventory-adjustments", "number"],
  ["invoices", "Invoice", "/invoices", "invoiceNumber"],
  ["bills", "Bill", "/bills", "billNumber"],
];
const ROUTER = { stockAdjustments: "inventoryAdjustments", payments: "payments", vendorPayments: "vendorPayments", creditNotes: "creditNotes", vendorCredits: "vendorCredits", expenses: "expenses", journals: "journals", invoices: "invoices", bills: "bills" };
const IMPORT_TYPE = { stockAdjustments: "stockAdjustment", payments: "payments", vendorPayments: "vendorPayments", creditNotes: "creditNotes", vendorCredits: "vendorCredits", expenses: "expense", journals: "journal", invoices: "invoices", bills: "bills" };
function undoQuery(req, q) {
  const src = ["tally", "zoho", "sheet"].includes(q.source) ? q.source : null;
  if (!src) throw new HttpError(400, "Choose where the data came from");
  const date = {};
  if (q.from) date.$gte = new Date(`${q.from}T00:00:00Z`);
  if (q.to) date.$lte = new Date(`${q.to}T23:59:59Z`);
  return { src, date: Object.keys(date).length ? date : null };
}
async function undoTargets(req, q) {
  const { src, date } = undoQuery(req, q);
  const out = [];
  for (const [type, model] of UNDO) {
    const M = require(`../models/${model}`);
    const esc = `${src}:${IMPORT_TYPE[type]}:`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = { organization: req.org, importRef: { $regex: `^${esc}` }, opening: { $ne: true }, ...(date ? { date } : {}) };
    const ids = (await M.find(filter, { _id: 1 }).lean()).map((d) => String(d._id));
    out.push({ type, label: LABELS[type], ids });
  }
  return out;
}

router.get(
  "/undo",
  ah(async (req, res) => {
    const t = await undoTargets(req, req.query);
    res.send({ counts: t.filter((x) => x.ids.length).map((x) => ({ type: x.type, label: x.label, count: x.ids.length })) });
  })
);

router.post(
  "/undo",
  ah(async (req, res) => {
    const { call } = require("../utils/import/commit");
    const targets = await undoTargets(req, req.body || {});
    const total = targets.reduce((n, t) => n + t.ids.length, 0);
    if (!total) throw new HttpError(400, "Nothing imported from that source in those dates");
    const ctx = { org: req.org, user: req.user };
    const jobId = crypto.randomUUID();
    const job = { kind: "undo", org: String(req.org), at: Date.now(), status: "running", done: 0, total, results: null, warnings: [], error: null };
    jobs.set(jobId, job);
    (async () => {
      const results = [];
      for (const { type, label, ids } of targets) {
        if (!ids.length) continue;
        const r = { type, label, deleted: 0, failed: [] };
        for (const id of ids) {
          try {
            await call(require(`./${ROUTER[type]}`), "DELETE", `/${id}`, ctx);
            r.deleted++;
          } catch (e) {
            r.failed.push(e.message);
          }
          job.done++;
          job.at = Date.now();
        }
        results.push(r);
      }
      job.results = results;
      job.status = "done";
    })().catch((e) => {
      job.status = "error";
      job.error = e.message;
    });
    res.send({ jobId, total });
  })
);

module.exports = router;
module.exports.LABELS = LABELS;
