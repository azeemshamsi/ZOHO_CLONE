/**
 * Amazon sales into OrdexaGo: preview (what will be created / skipped), import (background job), and the check
 * of the imported month against Amazon's GSTR-1 workbook and MTR totals.
 * Imported documents carry importRef "amazon:<seller GSTIN>:<report month>:<number>".
 */
const crypto = require("crypto");
const Invoice = require("../../models/Invoice");
const CreditNote = require("../../models/CreditNote");
const Customer = require("../../models/Customer");
const Item = require("../../models/Item");
const Account = require("../../models/Account");
const Organization = require("../../models/Organization");
const { computeTotals } = require("../gst");
const { round2 } = require("./common");
const A = require("./amazon");

const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const monthOfName = (name) => {
  const m = String(name || "").toUpperCase().match(new RegExp(`(${MONTHS.join("|")})-(\\d{4})`));
  return m ? `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}` : "";
};
const keyOf = (d) => d.toISOString().slice(0, 7);

/* ---------------- in-memory plans and jobs ---------------- */
const plans = new Map();
const jobs = new Map();
const sweep = () => {
  const old = Date.now() - 60 * 60000;
  for (const [k, v] of plans) if (v.at < old) plans.delete(k);
  for (const [k, v] of jobs) if (v.at < old && v.status !== "running") jobs.delete(k);
};

// SKU → item (Amazon FBA SKUs often end in "-FBA").
function skuMatcher(items) {
  const by = new Map();
  for (const i of items) if (i.sku) by.set(String(i.sku).trim().toLowerCase(), i);
  return (sku) => {
    const s = String(sku || "").trim().toLowerCase();
    if (!s) return null;
    return by.get(s) || by.get(s.replace(/[-_ ]?fba$/, "")) || by.get(s.replace(/^fba[-_ ]?/, "")) || null;
  };
}

/* ---------------- Amazon's figures per month (for the check) ---------------- */
const AmazonMonth = require("../../models/AmazonMonth");
const packPlan = (p) =>
  [...p.invoices, ...p.creditNotes].map((d) => ({ k: d.kind === "invoice" ? "invoice" : "creditNote", n: d.number, d: d.date, b2b: !!d.b2b, pos: d.pos, t: d.taxable, l: d.lines.map((l) => ({ h: l.hsn || "", r: Number(l.rate) || 0, t: l.taxable, s: l.sku || "" })) }));
const unpackPlan = (docs) => {
  const ds = (docs || []).map((x) => ({ kind: x.k, number: x.n, date: x.d ? new Date(x.d) : null, b2b: !!x.b2b, pos: x.pos, taxable: x.t, lines: (x.l || []).map((l) => ({ hsn: l.h, rate: l.r, taxable: l.t, sku: l.s, name: l.s })) }));
  return { invoices: ds.filter((d) => d.kind === "invoice"), creditNotes: ds.filter((d) => d.kind !== "invoice") };
};
async function keepMonth(org, gstin, month, p) {
  if (!month || !p) return;
  await AmazonMonth.updateOne({ organization: org, gstin, month }, { $set: { docs: packPlan(p) } }, { upsert: true }).catch((e) => console.error("Couldn't keep Amazon's figures:", e.message));
}

/* ---------------- posting: party and sales ledgers ---------------- */
// Tally-style: every Amazon document to one party ledger (e.g. "Amazon_SRE"), and each line to a sales ledger under
// the "Online Sale" master by type and rate — "Local B2B @ 5%", "OutState B2C @ 18%" … (local = seller's state).
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ledgerName = (local, b2b, rate) => `${local ? "Local" : "Outstate"} ${b2b ? "B2B" : "B2C"} @ ${Number(rate) || 0}%`;
const isAmazonParty = (c) => /^amazon[\s_-]*sre$/i.test(String(c.displayName || "").trim());

async function onlineMaster(org) {
  const LedgerGroup = require("../../models/LedgerGroup");
  const groups = await LedgerGroup.find({ organization: org, kind: "sales" });
  return groups.find((g) => norm(g.name) === "onlinesale") || groups.find((g) => norm(g.name).startsWith("onlinesale")) || null;
}

async function ledgerBook(org, group) {
  const { chartOfAccounts } = require("../ledger");
  const coa = await chartOfAccounts(org);
  const members = new Set(group?.members || []);
  const byName = new Map();
  // Members of the master first, then any sales ledger with the same name.
  for (const a of coa) if (members.has(a.code)) byName.set(norm(a.name), a.code);
  for (const a of coa) if (a.active !== false && !byName.has(norm(a.name)) && (a.ledgerKind === "sales" || a.type === "income")) byName.set(norm(a.name), a.code);
  return byName;
}
const keyFor = (local, b2b, rate) => norm(ledgerName(local, b2b, rate));
const docLines = (d, orgState) => d.lines.map((l) => ({ local: (d.pos || orgState) === orgState, b2b: !!d.b2b, rate: Number(l.rate) || 0 }));

// The ledgers a plan needs: which exist, which will be created (inside the master).
async function postingInfo(org, o, docs) {
  const group = await onlineMaster(org);
  const book = await ledgerBook(org, group);
  const need = new Map();
  for (const d of docs) for (const x of docLines(d, o.state)) need.set(keyFor(x.local, x.b2b, x.rate), ledgerName(x.local, x.b2b, x.rate));
  const ledgers = [...need.entries()].map(([k, name]) => ({ name, exists: book.has(k) })).sort((a, b) => a.name.localeCompare(b.name));
  const party = (await Customer.find({ organization: org }, { displayName: 1, gstin: 1 }).lean()).find(isAmazonParty) || null;
  return { group: group ? group.name : "", ledgers, party: party ? { _id: String(party._id), name: party.displayName } : null };
}

async function resolveLedger(org, group, book, local, b2b, rate) {
  const k = keyFor(local, b2b, rate);
  if (book.has(k)) return book.get(k);
  const a = await Account.create({ organization: org, name: ledgerName(local, b2b, rate), group: "Income", ledgerKind: "sales", description: "Amazon sales (created by the Amazon import)" });
  const code = String(a._id);
  book.set(k, code);
  if (group) {
    group.members = [...new Set([...(group.members || []), code])];
    await group.save();
  }
  return code;
}

// Invoices already on the Amazon party in the report month that didn't come from this import (e.g. from Tally).
async function existingOnParty(org, partyId, month) {
  if (!partyId || !month) return null;
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const rows = (await Invoice.find({ organization: org, customer: partyId, date: { $gte: from, $lt: to } }, { total: 1, importRef: 1 }).lean()).filter((x) => !String(x.importRef || "").startsWith("amazon:"));
  return rows.length ? { count: rows.length, total: round2(rows.reduce((t, x) => t + (x.total || 0), 0)) } : null;
}

/* ---------------- preview ---------------- */
async function preview(org, files) {
  sweep();
  const o = await Organization.findById(org);
  if (!o?.gstin) throw new Error("Add this company's GSTIN in Settings first: Amazon reports are matched by seller GSTIN");
  const u = A.unpack(files);
  if (!u.mtr.length) throw new Error(`No Amazon MTR (B2C / B2B) CSV found${u.unknown.length ? ` — not recognised: ${u.unknown.join(", ")}` : ""}`);
  const gstin = o.gstin.toUpperCase();
  const p = A.plan(u.mtr, gstin);
  const docs = [...p.invoices, ...p.creditNotes];
  // Report month: from the file name ("…OCTOBER-2026…"), else the month most documents fall in.
  const counts = {};
  for (const d of docs) if (d.date) counts[keyOf(d.date)] = (counts[keyOf(d.date)] || 0) + 1;
  const month = files.map((f) => monthOfName(f.name)).find(Boolean) || Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  // Already in OrdexaGo?
  const [invs, cns, items, buyers] = await Promise.all([
    Invoice.find({ organization: org, invoiceNumber: { $in: p.invoices.map((d) => d.number) } }, { invoiceNumber: 1, importRef: 1 }).lean(),
    CreditNote.find({ organization: org, number: { $in: p.creditNotes.map((d) => d.number) } }, { number: 1, importRef: 1 }).lean(),
    Item.find({ organization: org }, { sku: 1, name: 1, trackInventory: 1 }).lean(),
    Customer.find({ organization: org, gstin: { $in: [...new Set(p.invoices.concat(p.creditNotes).filter((d) => d.b2b).map((d) => d.buyerGstin))] } }, { gstin: 1, displayName: 1 }).lean(),
  ]);
  const have = new Map([...invs.map((x) => [`i|${x.invoiceNumber}`, x]), ...cns.map((x) => [`c|${x.number}`, x])]);
  // Orders OrdexaGo already invoiced from the Amazon connection (and their return credit notes): not imported again.
  const ShopifyOrder = require("../../models/ShopifyOrder");
  const orderIds = [...new Set(docs.flatMap((d) => [...d.orders]))].filter(Boolean);
  const apiOrders = orderIds.length ? (await ShopifyOrder.find({ channel: "amazon", shopifyId: { $in: orderIds.map((x) => `amazon:${x}`) } }, { shopifyId: 1, invoice: 1, invoiceOrg: 1, returnCreditNote: 1 }).lean()).filter((x) => String(x.invoiceOrg) === String(org)) : [];
  const byOrder = new Map(apiOrders.map((x) => [x.shopifyId.slice(7), x]));
  const fromApi = (d) => {
    const os = [...d.orders].filter(Boolean);
    if (!os.length) return null;
    const ids = os.map((x) => byOrder.get(x)?.[d.kind === "invoice" ? "invoice" : "returnCreditNote"]);
    return ids.every(Boolean) ? [...new Set(ids.map(String))] : null;
  };
  const match = skuMatcher(items);
  const unmatched = new Map();
  for (const d of docs) {
    const h = have.get(`${d.kind === "invoice" ? "i" : "c"}|${d.number}`);
    d.state = !h ? "new" : String(h.importRef || "").startsWith("amazon:") ? "imported" : "conflict";
    const api = d.state === "new" ? fromApi(d) : null;
    if (api) {
      d.state = "ordexago";
      d.link = api;
    }
    for (const l of d.lines) if (l.kind === "product" && !match(l.sku)) unmatched.set(l.sku || "(no SKU)", (unmatched.get(l.sku || "(no SKU)") || 0) + 1);
  }
  const newBuyers = [...new Set(docs.filter((d) => d.b2b && !buyers.some((b) => b.gstin === d.buyerGstin)).map((d) => `${d.buyerName || d.buyerGstin} (${d.buyerGstin})`))];
  const sum = (xs, f) => round2(xs.reduce((t, x) => t + f(x), 0));
  const part = (xs) => ({ count: xs.length, taxable: sum(xs, (d) => d.taxable), tax: sum(xs, (d) => d.amazon.tax), value: sum(xs, (d) => d.amazon.value), tcs: sum(xs, (d) => d.tcs) });
  const posting = await postingInfo(org, o, docs.filter((d) => d.state === "new"));
  posting.onParty = posting.party ? await existingOnParty(org, posting.party._id, month) : null;
  const id = crypto.randomUUID();
  plans.set(id, { org: String(org), gstin, month, plan: p, at: Date.now() });
  return {
    planId: id,
    gstin,
    month,
    files: u.names,
    unknownFiles: u.unknown,
    hasGstr1: u.gstr1.some((g) => g.gstin === gstin),
    b2cInvoices: part(p.invoices.filter((d) => !d.b2b)),
    b2bInvoices: part(p.invoices.filter((d) => d.b2b)),
    creditNotes: part(p.creditNotes),
    toCreate: docs.filter((d) => d.state === "new").length,
    alreadyImported: docs.filter((d) => d.state === "imported").length,
    fromOrders: docs.filter((d) => d.state === "ordexago").length,
    conflicts: docs.filter((d) => d.state === "conflict").map((d) => d.number),
    skipped: p.skipped,
    unmatchedSkus: [...unmatched.entries()].map(([sku, n]) => ({ sku, lines: n })).sort((a, b) => b.lines - a.lines),
    newBuyers,
    posting,
  };
}

/* ---------------- import ---------------- */
async function salesLedger(org, code) {
  if (code) return code;
  let a = await Account.findOne({ organization: org, name: "Amazon Sales" });
  if (!a) a = await Account.create({ organization: org, name: "Amazon Sales", group: "Income", ledgerKind: "sales", description: "Sales on Amazon (imported from Amazon's Merchant Tax Report)" });
  return String(a._id);
}

async function customerFor(org, d, cache) {
  const key = d.b2b ? d.buyerGstin : "_b2c";
  if (cache.has(key)) return cache.get(key);
  let c;
  if (!d.b2b) {
    c = await Customer.findOne({ organization: org, displayName: "Amazon B2C" });
    if (!c) c = await Customer.create({ organization: org, displayName: "Amazon B2C", companyName: "Amazon B2C customers", customerType: "individual", gstTreatment: "consumer", notes: "Amazon sales to consumers (imported from Amazon's MTR B2C report)" });
  } else {
    c = await Customer.findOne({ organization: org, gstin: d.buyerGstin });
    if (!c)
      c = await Customer.create({
        organization: org,
        displayName: d.buyerName || d.buyerGstin,
        companyName: d.buyerName || "",
        customerType: "business",
        gstin: d.buyerGstin,
        gstTreatment: "registered",
        placeOfSupply: d.buyerGstin.slice(0, 2),
        billingAddress: { city: d.billTo.city, state: d.billTo.state || d.buyerGstin.slice(0, 2), pincode: d.billTo.pincode, country: "India" },
        notes: "Amazon business buyer (imported from Amazon's MTR B2B report)",
      });
  }
  cache.set(key, c);
  return c;
}

function startImport(ctx, planId, { ledger, mode, party } = {}) {
  sweep();
  const pl = plans.get(planId);
  if (!pl || pl.org !== String(ctx.org)) throw new Error("This preview has expired. Upload the files again.");
  for (const j of jobs.values()) if (j.org === String(ctx.org) && j.status === "running") throw new Error("An Amazon import is already running for this company");
  const id = crypto.randomUUID();
  const docs = [...pl.plan.invoices, ...pl.plan.creditNotes].filter((d) => d.state === "new" || d.state === "ordexago");
  const job = { id, org: String(ctx.org), status: "running", total: docs.length, done: 0, created: { invoices: 0, creditNotes: 0, linked: 0 }, errors: [], warnings: [], at: Date.now(), month: pl.month };
  jobs.set(id, job);
  keepMonth(ctx.org, pl.gstin, pl.month, pl.plan);
  run(ctx, pl, docs, { ledger, mode, party }, job).catch((e) => {
    job.status = "failed";
    job.errors.push({ number: "", message: e.message });
  });
  return job;
}

async function run(ctx, pl, docs, opts, job) {
  const { call } = require("./commit");
  const org = await Organization.findById(ctx.org);
  // "online": a sales ledger per line by type and rate (Online Sale master); else one ledger for everything.
  const online = opts.mode === "online";
  const ledger = online ? "" : await salesLedger(ctx.org, opts.ledger);
  const group = online ? await onlineMaster(ctx.org) : null;
  const book = online ? await ledgerBook(ctx.org, group) : null;
  const party = opts.party ? await Customer.findOne({ _id: opts.party, organization: ctx.org }) : null;
  if (opts.party && !party) throw new Error("The party ledger chosen for Amazon wasn't found");
  const match = skuMatcher(await Item.find({ organization: ctx.org }, { sku: 1, name: 1, hsnSac: 1 }).lean());
  const cache = new Map();
  // Invoices first, so credit notes can link to them.
  docs.sort((a, b) => (a.kind === b.kind ? a.date - b.date : a.kind === "invoice" ? -1 : 1));
  for (const d of docs) {
    try {
      if (d.state === "ordexago") {
        // Already invoiced from the order: tag OrdexaGo's document with Amazon's number so the GSTR-1 check counts it.
        const Model = d.kind === "invoice" ? Invoice : CreditNote;
        const ref = `amazon:${pl.gstin}:${pl.month}:${d.number}`;
        let n = 0;
        for (const id of d.link || []) {
          await Model.updateOne({ _id: id, organization: ctx.org }, { $set: { importRef: n ? `${ref}#${n + 1}` : ref } });
          n++;
        }
        job.created.linked++;
        job.done++;
        continue;
      }
      const c = party || (await customerFor(ctx.org, d, cache));
      const sign = d.kind === "creditNote" ? -1 : 1;
      const lineItems = d.lines.map((l) => {
        const it = l.kind === "product" ? match(l.sku) : null;
        const taxable = sign * l.taxable;
        return {
          item: it ? String(it._id) : "",
          name: l.name.slice(0, 250),
          description: [l.kind === "product" && l.sku ? `SKU ${l.sku}` : "", l.orderId ? `Amazon order ${l.orderId}` : ""].filter(Boolean).join(" · "),
          hsnSac: l.hsn || it?.hsnSac || "",
          unit: "pcs",
          quantity: l.quantity,
          rate: r4(taxable / l.quantity),
          discount: 0,
          taxRate: l.rate,
          account: "",
        };
      });
      if (online) {
        const local = (d.pos || org.state) === org.state;
        for (let n = 0; n < lineItems.length; n++) lineItems[n].account = await resolveLedger(ctx.org, group, book, local, !!d.b2b, d.lines[n].rate);
      }
      if (lineItems.some((l) => l.rate < 0)) throw new Error("A line has a negative value (promotion larger than the item)");
      const pos = d.pos || org.state;
      // Tax rounding: a few paise so the total equals Amazon's invoice amount.
      const t = computeTotals({ lineItems, orgState: org.state, placeOfSupply: pos });
      const want = sign * d.amazon.value;
      let adjustment = round2(want - t.total);
      if (Math.abs(adjustment) > 2) {
        job.warnings.push({ number: d.number, message: `OrdexaGo's total ₹${t.total} differs from Amazon's ₹${want}; posted at OrdexaGo's GST` });
        adjustment = 0;
      }
      if ((t.igst > 0) !== (Math.abs(d.amazon.igst) > 0)) job.warnings.push({ number: d.number, message: `Amazon charged ${d.amazon.igst ? "IGST" : "CGST + SGST"}; place of supply ${pos} gives the other` });
      const iso = A.iso(d.date);
      const common = {
        customer: String(c._id),
        date: iso,
        placeOfSupply: pos,
        lineItems,
        ...(ledger ? { ledger } : {}),
        // One party ledger for all Amazon sales: the business buyer's GSTIN stays on the document for GSTR-1 (B2B).
        ...(party && d.b2b ? { customerGstin: d.buyerGstin } : {}),
        ...(adjustment ? { adjustment } : {}),
        shipTo: { name: "", phone: "", street: "", city: d.shipTo.city, state: d.shipTo.state, pincode: d.shipTo.pincode, country: "India" },
        customerNotes: `${party && d.b2b ? `Buyer: ${d.buyerName || ""} (${d.buyerGstin}) · ` : ""}Amazon ${d.channel === "AFN" ? "FBA" : d.channel === "MFN" ? "self-ship" : ""} order${d.orders.length > 1 ? "s" : ""} ${d.orders.join(", ")}${d.payment ? ` · ${d.payment}` : ""}${d.tcs ? ` · TCS by Amazon ₹${Math.abs(d.tcs)}` : ""}`,
      };
      const ref = `amazon:${pl.gstin}:${pl.month}:${d.number}`;
      if (d.kind === "invoice") {
        const inv = await call(require("../../routes/invoices"), "POST", "/", ctx, { ...common, invoiceNumber: d.number, dueDate: iso, status: "sent" });
        const set = { importRef: ref };
        if (d.irn) Object.assign(set, { "einvoice.status": "generated", "einvoice.irn": d.irn, "einvoice.via": "amazon", ...(d.irnDate ? { "einvoice.ackDate": new Date(`${d.irnDate.replace(" ", "T")}+05:30`) } : {}) });
        await Invoice.updateOne({ _id: inv._id }, { $set: set });
        job.created.invoices++;
      } else {
        const inv = d.invoiceNumber ? await Invoice.findOne({ organization: ctx.org, invoiceNumber: d.invoiceNumber, customer: c._id }, { _id: 1 }).lean() : null;
        const cn = await call(require("../../routes/creditNotes"), "POST", "/", ctx, { ...common, number: d.number, reference: `Amazon refund against ${d.invoiceNumber}`, invoice: inv ? String(inv._id) : "", reason: "Sales return (Amazon refund)", status: "open" });
        await CreditNote.updateOne({ _id: cn._id }, { $set: { importRef: ref } });
        job.created.creditNotes++;
      }
    } catch (e) {
      job.errors.push({ number: d.number, message: e.message });
    }
    job.done++;
  }
  job.status = "done";
  job.finishedAt = new Date();
}

const jobOf = (org, id) => {
  const j = jobs.get(id);
  return j && j.org === String(org) ? j : null;
};

/* ---------------- check against Amazon's GSTR-1 ---------------- */
async function imported(org, gstin, month) {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 2, 1));
  const to = new Date(Date.UTC(y, m + 1, 1));
  const prefix = `amazon:${gstin}:${month}:`;
  const q = { organization: org, date: { $gte: from, $lt: to } };
  const [invs, cns] = await Promise.all([Invoice.find(q).lean(), CreditNote.find(q).lean()]);
  const mine = (x) => String(x.importRef || "").startsWith(prefix);
  return { invoices: invs.filter(mine), creditNotes: cns.filter(mine) };
}

async function reconcile(org, month, files) {
  const o = await Organization.findById(org);
  const gstin = String(o.gstin || "").toUpperCase();
  const u = A.unpack(files);
  const g1 = u.gstr1.find((g) => g.gstin === gstin);
  if (!g1) throw new Error(`Upload Amazon's GSTR-1 report for ${gstin} (the .xlsx, or the zip it came in)`);
  const amz = A.readGstr1(g1.wb);
  const { invoices, creditNotes } = await imported(org, gstin, month);
  const r2 = round2;
  const isB2b = (d) => !!d.customerGstin;
  const rate = (l) => Number(l.taxRate) || 0;
  const row = (key, label, a, b) => ({ key, label, amazon: r2(a || 0), ordexago: r2(b || 0), diff: r2((b || 0) - (a || 0)), ok: Math.abs((b || 0) - (a || 0)) < 0.05 });

  // B2B: per invoice (value, taxable)
  const ab = new Map();
  for (const r of amz.b2b) {
    const x = ab.get(r.number) || { number: r.number, gstin: r.gstin, value: r.value, taxable: 0 };
    x.taxable = r2(x.taxable + r.taxable);
    ab.set(r.number, x);
  }
  const ob = new Map(invoices.filter(isB2b).map((d) => [d.invoiceNumber, { number: d.invoiceNumber, gstin: d.customerGstin, value: d.total, taxable: d.subTotal, id: d._id }]));
  const b2b = [...new Set([...ab.keys(), ...ob.keys()])].map((n) => {
    const a = ab.get(n);
    const b = ob.get(n);
    return { number: n, gstin: a?.gstin || b?.gstin, id: b?.id || null, amazon: a ? { value: a.value, taxable: a.taxable } : null, ordexago: b ? { value: b.value, taxable: b.taxable } : null, ok: !!a && !!b && Math.abs(a.taxable - b.taxable) < 0.05 && Math.abs(a.value - b.value) < 1 };
  });

  // Credit notes to registered buyers (CDNR)
  const ac = new Map(amz.cdnr.map((r) => [r.number, r]));
  const oc = new Map(creditNotes.filter(isB2b).map((d) => [d.number, d]));
  const cdnr = [...new Set([...ac.keys(), ...oc.keys()])].map((n) => {
    const a = ac.get(n);
    const b = oc.get(n);
    return { number: n, id: b?._id || null, amazon: a ? { value: a.value, taxable: a.taxable } : null, ordexago: b ? { value: b.total, taxable: b.subTotal } : null, ok: !!a && !!b && Math.abs(a.taxable - b.subTotal) < 0.05 };
  });

  // B2C small: taxable by place of supply + rate (invoices less credit notes)
  const add = (m, k, v) => m.set(k, r2((m.get(k) || 0) + v));
  const as = new Map();
  for (const r of amz.b2cs) add(as, `${r.pos}|${r.rate}`, r.taxable);
  for (const r of amz.b2cl) add(as, `${r.pos}|${r.rate}`, r.taxable);
  const os = new Map();
  // Which documents make up each row (OrdexaGo side; Amazon side too when the MTR files are uploaded).
  const contrib = { b2c: new Map(), hsn: new Map() };
  const put = (sec, key, side, doc, amt) => {
    const m = contrib[sec].get(key) || new Map();
    const k = `${doc.kind}|${doc.number}`;
    const x = m.get(k) || { number: doc.number, kind: doc.kind, id: null, amazon: 0, ordexago: 0 };
    if (doc.id) x.id = doc.id;
    x[side] = r2(x[side] + amt);
    m.set(k, x);
    contrib[sec].set(key, m);
  };
  const oDoc = (d, kind) => ({ number: kind === "invoice" ? d.invoiceNumber : d.number, kind, id: d._id });
  for (const d of invoices.filter((x) => !isB2b(x))) for (const l of d.lineItems) (add(os, `${d.placeOfSupply}|${rate(l)}`, l.amount), put("b2c", `${d.placeOfSupply}|${rate(l)}`, "ordexago", oDoc(d, "invoice"), l.amount));
  for (const d of creditNotes.filter((x) => !isB2b(x))) for (const l of d.lineItems) (add(os, `${d.placeOfSupply}|${rate(l)}`, -l.amount), put("b2c", `${d.placeOfSupply}|${rate(l)}`, "ordexago", oDoc(d, "creditNote"), -l.amount));
  const STATES = require("../states").STATES;
  const sname = (c) => (STATES.find(([k]) => k === c) || [c, c])[1];
  const b2c = [...new Set([...as.keys(), ...os.keys()])]
    .map((k) => {
      const [pos, rt] = k.split("|");
      return row(k, `${pos}-${sname(pos)} @ ${rt}%`, as.get(k), os.get(k));
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // HSN: taxable by HSN + rate
  const ah = new Map();
  for (const r of amz.hsn) add(ah, `${r.hsn}|${r.rate}`, r.taxable);
  const oh = new Map();
  for (const d of invoices) for (const l of d.lineItems) (add(oh, `${l.hsnSac || ""}|${rate(l)}`, l.amount), put("hsn", `${l.hsnSac || ""}|${rate(l)}`, "ordexago", oDoc(d, "invoice"), l.amount));
  for (const d of creditNotes) for (const l of d.lineItems) (add(oh, `${l.hsnSac || ""}|${rate(l)}`, -l.amount), put("hsn", `${l.hsnSac || ""}|${rate(l)}`, "ordexago", oDoc(d, "creditNote"), -l.amount));
  // Amazon's per-document figures: from MTR files uploaded with the check (kept for next time), else as kept at import.
  let mtrPlan = null;
  if (u.mtr.length) {
    mtrPlan = A.plan(u.mtr, gstin);
    await keepMonth(org, gstin, month, mtrPlan);
  } else {
    const kept = await AmazonMonth.findOne({ organization: org, gstin, month }).lean();
    if (kept?.docs?.length) mtrPlan = unpackPlan(kept.docs);
  }
  if (mtrPlan)
    for (const d of [...mtrPlan.invoices, ...mtrPlan.creditNotes]) {
      const doc = { number: d.number, kind: d.kind === "invoice" ? "invoice" : "creditNote" };
      for (const l of d.lines) {
        put("hsn", `${l.hsn || ""}|${Number(l.rate) || 0}`, "amazon", doc, l.taxable);
        if (!d.b2b) put("b2c", `${d.pos}|${Number(l.rate) || 0}`, "amazon", doc, l.taxable);
      }
    }
  const allOurs = new Map([...invoices.map((d) => [`invoice|${d.invoiceNumber}`, d._id]), ...creditNotes.map((d) => [`creditNote|${d.number}`, d._id])]);
  // Whole-document totals on both sides: a document whose total agrees is right even if a line sits under another HSN.
  const ourTotal = new Map([...invoices.map((d) => [`invoice|${d.invoiceNumber}`, Math.abs(d.subTotal)]), ...creditNotes.map((d) => [`creditNote|${d.number}`, Math.abs(d.subTotal)])]);
  const amzTotal = new Map(mtrPlan ? [...mtrPlan.invoices, ...mtrPlan.creditNotes].map((d) => [`${d.kind === "invoice" ? "invoice" : "creditNote"}|${d.number}`, Math.abs(d.taxable)]) : []);
  // Rows that don't match carry their documents, those that differ first.
  const withDocs = (sec, rows) =>
    rows.map((r) => {
      if (r.ok) return r;
      const docs = [...(contrib[sec].get(r.key) || new Map()).values()].map((x) => {
        const have = allOurs.get(`${x.kind}|${x.number}`);
        const elsewhere = !x.id && !!have;
        const diff = r2(x.ordexago - x.amazon);
        // Needs correction: missing from OrdexaGo or a different amount. Not: in OrdexaGo under the item's HSN
        // (Amazon gave none, or a different one) — the document itself is right.
        const k = `${x.kind}|${x.number}`;
        const wholeOk = ourTotal.has(k) && amzTotal.has(k) && Math.abs(ourTotal.get(k) - amzTotal.get(k)) < 0.05;
        const status = Math.abs(diff) < 0.05 ? "ok" : !have ? "missing" : wholeOk ? "regrouped" : "differs";
        return { ...x, id: x.id || have || null, elsewhere, diff, status };
      });
      docs.sort((a, b) => (mtrPlan ? Math.abs(b.diff) - Math.abs(a.diff) : 0) || a.number.localeCompare(b.number));
      return { ...r, docs, sides: mtrPlan ? "both" : "ordexago" };
    });
  const hsn = [...new Set([...ah.keys(), ...oh.keys()])].map((k) => {
    const [h, rt] = k.split("|");
    return row(k, `${h || "(no HSN)"} @ ${rt}%`, ah.get(k), oh.get(k));
  });
  const hsnRows = withDocs("hsn", hsn);
  const b2cRows = withDocs("b2c", b2c);

  // Document by document, when the MTR files are uploaded with the GSTR-1: what's missing, different, or
  // where Amazon gave no HSN (OrdexaGo then uses the item's HSN, so the HSN summary differs on purpose).
  let documents = null;
  let noHsnProducts = [];
  if (mtrPlan) {
    const p = mtrPlan;
    const byInv = new Map(invoices.map((d) => [d.invoiceNumber, d]));
    const byCn = new Map(creditNotes.map((d) => [d.number, d]));
    const planDocs = [...p.invoices, ...p.creditNotes];
    const lost = planDocs.filter((d) => !(d.kind === "invoice" ? byInv : byCn).has(d.number));
    const [oi, oc] = await Promise.all([
      Invoice.find({ organization: org, invoiceNumber: { $in: lost.filter((d) => d.kind === "invoice").map((d) => d.number) } }, { invoiceNumber: 1, importRef: 1, date: 1, customerName: 1, subTotal: 1 }).lean(),
      CreditNote.find({ organization: org, number: { $in: lost.filter((d) => d.kind !== "invoice").map((d) => d.number) } }, { number: 1, importRef: 1, date: 1, customerName: 1, subTotal: 1 }).lean(),
    ]);
    const other = new Map([...oi.map((x) => [`invoice|${x.invoiceNumber}`, x]), ...oc.map((x) => [`creditNote|${x.number}`, x])]);
    const rows = [];
    const day = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "");
    for (const d of planDocs) {
      const kind = d.kind === "invoice" ? "invoice" : "creditNote";
      const ours = (kind === "invoice" ? byInv : byCn).get(d.number);
      const amzTaxable = r2(Math.abs(d.taxable));
      const base = { number: d.number, kind, date: day(d.date), b2b: !!d.b2b, amazon: amzTaxable };
      if (!ours) {
        const o = other.get(`${kind}|${d.number}`);
        rows.push({ ...base, ordexago: null, id: o?._id || null, problem: "missing", note: o ? `Number already used by another ${kind === "invoice" ? "invoice" : "credit note"}${o.customerName ? ` (${o.customerName}` : " ("}${o.importRef ? `, imported as ${o.importRef}` : ", not from this import"}, ${day(o.date)}) — if it's the same sale, it's already in the books but not counted here; otherwise change one of the numbers and import again` : "Not in OrdexaGo — import the same MTR file again; only missing documents are created" });
        continue;
      }
      const diff = r2(Math.abs(ours.subTotal) - amzTaxable);
      if (Math.abs(diff) >= 0.05) rows.push({ ...base, ordexago: r2(Math.abs(ours.subTotal)), id: ours._id, problem: "differs", note: `Taxable differs by ${diff} — open it and compare its lines with Amazon's (edit, or delete it and import again)` });
      const blank = d.lines.filter((l) => !l.hsn);
      if (blank.length) {
        const products = d.lines.map((l, i) => (!l.hsn ? { sku: l.sku || l.name || "?", hsn: ours.lineItems[i]?.hsnSac || "none", taxable: r2(Math.abs(l.taxable)) } : null)).filter(Boolean);
        const used = [...new Set(products.map((m) => m.hsn))].join(", ");
        rows.push({ ...base, products, ordexago: r2(Math.abs(ours.subTotal)), id: ours._id, problem: "no_hsn", note: `Amazon gave no HSN for ${[...new Set(blank.map((l) => l.sku || l.name))].join(", ")}; OrdexaGo used the item's HSN (${used}). Your GSTR-1 will show it under that HSN, so this HSN row won't match Amazon's. Fix the HSN on the Amazon listing for future months.` });
      }
    }
    // Imported for this month but not in these MTR files.
    const inPlan = new Set(planDocs.map((d) => `${d.kind === "invoice" ? "invoice" : "creditNote"}|${d.number}`));
    for (const d of invoices) if (!inPlan.has(`invoice|${d.invoiceNumber}`)) rows.push({ number: d.invoiceNumber, kind: "invoice", date: day(d.date), b2b: !!d.customerGstin, amazon: null, ordexago: r2(d.subTotal), id: d._id, problem: "extra", note: "Imported for this month but not in these MTR files" });
    for (const d of creditNotes) if (!inPlan.has(`creditNote|${d.number}`)) rows.push({ number: d.number, kind: "creditNote", date: day(d.date), b2b: !!d.customerGstin, amazon: null, ordexago: r2(d.subTotal), id: d._id, problem: "extra", note: "Imported for this month but not in these MTR files" });
    // Products Amazon sent without an HSN, and the HSN OrdexaGo used instead.
    const prod = new Map();
    for (const x of rows.filter((r) => r.problem === "no_hsn")) for (const m of x.products || []) {
      const e = prod.get(m.sku) || { sku: m.sku, hsn: new Set(), invoices: 0, taxable: 0 };
      e.hsn.add(m.hsn);
      e.invoices++;
      e.taxable = r2(e.taxable + m.taxable);
      prod.set(m.sku, e);
    }
    noHsnProducts = [...prod.values()].map((e) => ({ ...e, hsn: [...e.hsn].join(", ") }));
    const order = { missing: 0, differs: 1, extra: 2, no_hsn: 3 };
    rows.sort((a, b) => order[a.problem] - order[b.problem] || a.number.localeCompare(b.number));
    const missingTaxable = r2(rows.filter((x) => x.problem === "missing").reduce((t, x) => t + (x.kind === "invoice" ? x.amazon : -x.amazon), 0));
    documents = { rows, ok: !rows.some((x) => x.problem !== "no_hsn"), checked: planDocs.length, missingTaxable, noHsnProducts, source: u.mtr.length ? "uploaded" : "kept" };
  }

  const tot = (xs, f) => r2(xs.reduce((t, x) => t + f(x), 0));
  return {
    month,
    gstin,
    file: g1.name,
    imported: { invoices: invoices.length, creditNotes: creditNotes.length, taxable: r2(tot(invoices, (d) => d.subTotal) - tot(creditNotes, (d) => d.subTotal)), value: r2(tot(invoices, (d) => d.total) - tot(creditNotes, (d) => d.total)) },
    sections: {
      b2b: { rows: b2b, ok: b2b.every((r) => r.ok) },
      cdnr: { rows: cdnr, ok: cdnr.every((r) => r.ok) },
      b2c: { rows: b2cRows, ok: b2c.every((r) => r.ok), amazon: tot(b2c, (r) => r.amazon), ordexago: tot(b2c, (r) => r.ordexago) },
      hsn: { rows: hsnRows, ok: hsn.every((r) => r.ok), amazon: tot(hsn, (r) => r.amazon), ordexago: tot(hsn, (r) => r.ordexago) },
      ...(documents ? { documents } : {}),
    },
  };
}

// Months imported so far, with counts and totals (for the Amazon page).
async function months(org) {
  const o = await Organization.findById(org, { gstin: 1 });
  const since = new Date(Date.now() - 400 * 86400000);
  const [invs, cns] = await Promise.all([
    Invoice.find({ organization: org, date: { $gte: since } }, { importRef: 1, subTotal: 1, total: 1, customerGstin: 1 }).lean(),
    CreditNote.find({ organization: org, date: { $gte: since } }, { importRef: 1, subTotal: 1, total: 1 }).lean(),
  ]);
  const by = new Map();
  const take = (d, kind) => {
    const m = String(d.importRef || "").match(/^amazon:([^:]+):(\d{4}-\d{2}):/);
    if (!m) return;
    const k = `${m[1]}|${m[2]}`;
    const x = by.get(k) || { gstin: m[1], month: m[2], invoices: 0, b2b: 0, creditNotes: 0, taxable: 0, value: 0 };
    if (kind === "i") {
      x.invoices++;
      if (d.customerGstin) x.b2b++;
      x.taxable = round2(x.taxable + d.subTotal);
      x.value = round2(x.value + d.total);
    } else {
      x.creditNotes++;
      x.taxable = round2(x.taxable - d.subTotal);
      x.value = round2(x.value - d.total);
    }
    by.set(k, x);
  };
  invs.forEach((d) => take(d, "i"));
  cns.forEach((d) => take(d, "c"));
  return { gstin: o?.gstin || "", months: [...by.values()].sort((a, b) => b.month.localeCompare(a.month)) };
}

module.exports = { preview, startImport, jobOf, reconcile, months, monthOfName, salesLedger, skuMatcher, ledgerName, keyFor, norm };
