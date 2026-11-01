/**
 * Write normalised import records into MGI, in dependency order:
 *   accounts → customers/vendors → opening balances → invoices/bills/notes → payments → expenses → journals
 * Documents go through MGI's own create routes (same validation, GST maths and settlement as the
 * app). Every record gets an importRef, so importing the same file twice doesn't duplicate anything.
 */
const C = require("./common");
const { clean, round2, iso } = C;
const Account = require("../../models/Account");
const Customer = require("../../models/Customer");
const Vendor = require("../../models/Vendor");
const Invoice = require("../../models/Invoice");
const Bill = require("../../models/Bill");
const CreditNote = require("../../models/CreditNote");
const VendorCredit = require("../../models/VendorCredit");
const Payment = require("../../models/Payment");
const VendorPayment = require("../../models/VendorPayment");
const Expense = require("../../models/Expense");
const Journal = require("../../models/Journal");
const Organization = require("../../models/Organization");
const Currency = require("../../models/Currency");
const { chartOfAccounts } = require("../ledger");
const { computeTotals } = require("../gst");
const { nextNumber } = require("../../models/Counter");

// Call one of MGI's own routers in-process (no HTTP), e.g. call(invoicesRouter, "POST", "/", ctx, body).
function call(router, method, url, ctx, body) {
  return new Promise((resolve, reject) => {
    const [path, qs] = url.split("?");
    const req = { method, url, originalUrl: url, baseUrl: "", path, body: body || {}, query: Object.fromEntries(new URLSearchParams(qs || "")), params: {}, headers: {}, get: () => undefined, org: ctx.org, user: ctx.user };
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      send(d) {
        if (this.statusCode >= 400) reject(Object.assign(new Error(d?.message || "Request failed"), { status: this.statusCode }));
        else resolve(d);
        return this;
      },
      json(d) {
        return this.send(d);
      },
      setHeader() {},
    };
    router.handle(req, res, (err) => reject(err || new Error(`No route ${method} ${url}`)));
  });
}
const R = (name) => require(`../../routes/${name}`);

// Names people use for MGI's built-in accounts (lower-case → code).
function systemSynonyms(code, name) {
  const extra = {
    cash: ["cash", "cash in hand", "cash-in-hand", "petty cash"],
    bank: ["bank", "bank account"],
    ar: ["accounts receivable", "sundry debtors", "debtors", "trade receivables"],
    ap: ["accounts payable", "sundry creditors", "creditors", "trade payables"],
    sales: ["sales", "sales account", "sales accounts", "sales - gst", "sales gst", "local sales", "domestic sales", "revenue"],
    cogs: ["cost of goods sold", "purchase", "purchases", "purchase account", "purchase accounts", "purchase - gst", "purchases gst", "local purchase"],
    owners_equity: ["owner's equity", "owners equity", "capital account", "capital", "proprietor's capital", "partners capital"],
    opening_equity: ["opening balance equity", "opening balance adjustments", "difference in opening balances"],
    adjustments: ["rounding & adjustments", "round off", "rounding off", "round-off", "rounded off", "rounding"],
    shipping_income: ["shipping charge", "shipping charges", "freight outward"],
    other_income: ["other income", "misc income", "miscellaneous income"],
    drawings: ["drawings", "owner's drawings"],
    inventory: ["inventory asset", "stock in hand", "stock-in-hand", "closing stock", "inventory"],
    fixed_assets: ["fixed assets"],
    acc_depreciation: ["accumulated depreciation"],
    depreciation: ["depreciation", "depreciation expense"],
  }[code];
  return [name.toLowerCase(), ...(extra || [])];
}
function taxCode(name) {
  const n = name.toLowerCase();
  const side = /input|itc|purchase|receivable|\bin\b/.test(n) ? "input" : /output|sales|payable|\bout\b/.test(n) ? "output" : null;
  const t = /igst/.test(n) ? "igst" : /cgst/.test(n) ? "cgst" : /sgst|utgst/.test(n) ? "sgst" : null;
  return side && t ? `${side}_${t}` : null;
}

async function commit(ctx, data, opts, progress) {
  const org = await Organization.findById(ctx.org);
  const src = data.source; // "zoho" | "tally" | "sheet"
  const ref = (type, k) => `${src}:${type}:${clean(k).toLowerCase()}`;
  const results = {};
  const R_ = (t) => (results[t] = results[t] || { created: 0, skipped: 0, failed: [] });
  const fail = (t, label, e) => R_(t).failed.push({ ref: label, error: e.message || String(e) });
  const warnings = [...(data.warnings || [])];
  const openingDate = opts.openingDate ? new Date(`${opts.openingDate}T00:00:00Z`) : null;
  const dayBefore = (d) => new Date(d.getTime());

  /* ---------- account name → code ---------- */
  const accByName = new Map();
  const refreshAccounts = async () => {
    for (const a of await chartOfAccounts(ctx.org)) {
      for (const n of a.system ? systemSynonyms(a.code, a.name) : [a.name.toLowerCase()]) if (!accByName.has(n)) accByName.set(n, a.code);
      if (a.accountCode) accByName.set(String(a.accountCode).toLowerCase(), a.code);
    }
  };
  await refreshAccounts();
  const accounts = await chartOfAccounts(ctx.org);
  const groupOfCode = (code) => accounts.find((a) => a.code === code)?.group || "";
  const lookupAccount = (name) => {
    const n = clean(name).toLowerCase();
    if (!n) return null;
    return accByName.get(n) || taxCode(n) || accByName.get(n.replace(/\s*\(.*\)$/, "")) || null;
  };

  /* ---------- 1. Accounts ---------- */
  for (const a of data.records.accounts || []) {
    progress();
    try {
      if (lookupAccount(a.name)) {
        R_("accounts").skipped++;
        continue;
      }
      let group = a.group;
      if (group === "debtors" || group === "creditors") {
        accByName.set(a.name.toLowerCase(), group === "debtors" ? "ar" : "ap");
        R_("accounts").skipped++;
        continue;
      }
      if (!group) {
        group = "Other Current Asset";
        warnings.push(`Account "${a.name}" (type "${a.type || "?"}") was put under Other Current Asset — change it in Chart of Accounts if needed`);
      }
      const doc = await Account.create({ organization: ctx.org, name: a.name, group, accountCode: a.code || "", description: a.description || "" });
      accByName.set(a.name.toLowerCase(), String(doc._id));
      R_("accounts").created++;
    } catch (e) {
      fail("accounts", a.name, e);
    }
  }
  if (data.ledgerGroup)
    for (const [name, g] of Object.entries(data.ledgerGroup)) {
      if (g === "debtors" && !accByName.has(name)) accByName.set(name, "ar");
      if (g === "creditors" && !accByName.has(name)) accByName.set(name, "ap");
    }
  await refreshAccounts();

  /* ---------- 2. Customers and vendors ---------- */
  const currencies = new Set((await Currency.find({ organization: ctx.org }).lean()).map((c) => c.code));
  const contacts = { customer: new Map(), vendor: new Map() };
  for (const c of await Customer.find({ organization: ctx.org }).lean()) contacts.customer.set(c.displayName.toLowerCase(), c);
  for (const v of await Vendor.find({ organization: ctx.org }).lean()) contacts.vendor.set(v.displayName.toLowerCase(), v);
  const makeContact = async (kind, c) => {
    const M = kind === "customer" ? Customer : Vendor;
    let currency = "INR";
    if (c.currency && c.currency !== "INR") {
      if (currencies.has(c.currency)) currency = c.currency;
      else warnings.push(`${c.displayName}: currency ${c.currency} isn't set up in Currencies, so it was imported in INR`);
    }
    const doc = await M.create({
      organization: ctx.org,
      displayName: c.displayName,
      companyName: c.companyName || "",
      email: c.email || "",
      phone: c.phone || "",
      gstTreatment: c.gstTreatment || "consumer",
      gstin: c.gstin || "",
      placeOfSupply: c.placeOfSupply || (c.gstTreatment === "overseas" ? "" : org.state),
      billingAddress: c.billingAddress || {},
      ...(c.paymentTerms !== null && c.paymentTerms !== undefined ? { paymentTerms: c.paymentTerms } : {}),
      currency,
    });
    const o = doc.toObject();
    contacts[kind].set(c.displayName.toLowerCase(), o);
    return o;
  };
  const party = async (kind, name, t, label) => {
    const n = clean(name).toLowerCase();
    if (!n) throw new Error(`No ${kind} name`);
    if (contacts[kind].has(n)) return contacts[kind].get(n);
    warnings.push(`${label}: ${kind} "${name}" wasn't in the file's contacts, so it was created`);
    return makeContact(kind, { displayName: clean(name) });
  };
  for (const kind of ["customer", "vendor"])
    for (const c of data.records[`${kind}s`] || []) {
      progress();
      try {
        if (contacts[kind].has(c.displayName.toLowerCase())) R_(`${kind}s`).skipped++;
        else {
          await makeContact(kind, c);
          R_(`${kind}s`).created++;
        }
      } catch (e) {
        fail(`${kind}s`, c.displayName, e);
      }
    }

  /* ---------- 3. Opening balances ---------- */
  const withOpening = [...(data.records.accounts || []).filter((a) => round2(a.opening) && !["debtors", "creditors"].includes(a.group)), ...(data.records.openingBalances || []).map((o) => ({ name: o.account, type: o.type, opening: round2(o.debit - o.credit) }))];
  const contactOpenings = ["customer", "vendor"].flatMap((k) => (data.records[`${k}s`] || []).filter((c) => round2(c.opening) || (c.openingBills || []).length).map((c) => ({ ...c, kind: k })));
  if ((withOpening.length || contactOpenings.length) && !openingDate) warnings.push("Opening balances were found but no opening balance date was given, so they were not imported");
  if (openingDate && withOpening.length) {
    progress();
    const key = ref("opening", iso(openingDate));
    try {
      if (await Journal.exists({ organization: ctx.org, importRef: key })) R_("openingBalances").skipped++;
      else {
        const lines = [];
        const missing = [];
        for (const a of withOpening) {
          let code = lookupAccount(a.name);
          if (!code && a.type) {
            const g = require("./sheets").mapGroup(a.type);
            if (g && !["debtors", "creditors"].includes(g)) {
              const d = await Account.create({ organization: ctx.org, name: a.name, group: g });
              code = String(d._id);
              accByName.set(a.name.toLowerCase(), code);
            }
          }
          if (!code) {
            missing.push(a.name);
            continue;
          }
          if (["ar", "ap"].includes(code)) {
            warnings.push(`Opening balance on "${a.name}" (${code === "ar" ? "receivables" : "payables"}) was skipped — import customer/vendor opening balances instead, so each party's balance is right`);
            continue;
          }
          lines.push({ account: code, description: "Opening balance", debit: a.opening > 0 ? round2(a.opening) : 0, credit: a.opening < 0 ? round2(-a.opening) : 0 });
        }
        if (missing.length) warnings.push(`Opening balances skipped for unknown accounts: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? "…" : ""} — import the chart of accounts first`);
        const diff = round2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
        if (diff) lines.push({ account: "opening_equity", description: "Balancing figure", debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0 });
        if (lines.length) {
          const total = round2(lines.reduce((s, l) => s + l.debit, 0));
          await Journal.create({ organization: ctx.org, number: await nextNumber(ctx.org, "journal", org.journalPrefix || "MJ-"), date: openingDate, reference: "Opening balances", notes: "Opening balances imported", lines, total, importRef: key });
          R_("openingBalances").created++;
          // Customer/vendor openings post to Opening Balance Equity too, so only warn about what's left after them.
          const parties = round2(contactOpenings.reduce((s, c) => s + (c.kind === "customer" ? 1 : -1) * ((c.openingBills || []).length ? c.openingBills.reduce((t, b) => t + b.amount, 0) : c.opening), 0));
          const left = round2(diff + parties);
          if (Math.abs(left) >= 1) warnings.push(`Opening balances (including customers and vendors) don't balance by ₹${Math.abs(left)}; the difference is in Opening Balance Equity`);
        }
      }
    } catch (e) {
      fail("openingBalances", "Opening balances", e);
    }
  }
  if (openingDate)
    for (const c of contactOpenings) {
      progress();
      const p = contacts[c.kind].get(c.displayName.toLowerCase());
      if (!p) continue;
      const bills = (c.openingBills || []).length ? c.openingBills : [{ number: "", date: openingDate, amount: c.opening }];
      for (const [i, b] of bills.entries()) {
        const amt = round2(b.amount);
        if (!amt) continue;
        const key = ref(`ob-${c.kind}`, `${c.displayName}|${b.number || i}`);
        const isCredit = amt < 0;
        const M = c.kind === "customer" ? (isCredit ? CreditNote : Invoice) : isCredit ? VendorCredit : Bill;
        try {
          if (await M.exists({ organization: ctx.org, importRef: key })) {
            R_("openingBalances").skipped++;
            continue;
          }
          const d = b.date && b.date <= openingDate ? b.date : dayBefore(openingDate);
          const due = iso(new Date(d.getTime() + (p.paymentTerms || 0) * 86400000));
          const line = [{ name: `Opening balance${b.number ? ` (${b.number})` : ""}`, quantity: 1, rate: Math.abs(amt), taxRate: 0 }];
          const pos = p.placeOfSupply || org.state;
          let doc;
          if (c.kind === "customer" && !isCredit) {
            let no = b.number ? clean(b.number).slice(0, 30) : "";
            if (no && (await Invoice.exists({ organization: ctx.org, invoiceNumber: no }))) no = `${no}-OB`;
            doc = await call(R("invoices"), "POST", "/", ctx, { customer: String(p._id), invoiceNumber: no, date: iso(d), dueDate: due, status: "sent", placeOfSupply: pos, lineItems: line });
          } else if (c.kind === "vendor" && !isCredit) {
            doc = await call(R("bills"), "POST", "/", ctx, { vendor: String(p._id), billNumber: b.number || `OB-${iso(openingDate)}-${i + 1}`, date: iso(d), dueDate: due, status: "open", placeOfSupply: pos, lineItems: line });
          } else if (c.kind === "customer") {
            doc = await call(R("creditNotes"), "POST", "/", ctx, { customer: String(p._id), date: iso(d), status: "open", reason: "Opening balance", placeOfSupply: pos, lineItems: line });
          } else {
            doc = await call(R("vendorCredits"), "POST", "/", ctx, { vendor: String(p._id), date: iso(d), status: "open", reason: "Opening balance", placeOfSupply: pos, lineItems: line });
          }
          await M.updateOne({ _id: doc._id }, { opening: true, importRef: key });
          R_("openingBalances").created++;
        } catch (e) {
          fail("openingBalances", `${c.displayName} ${b.number || ""}`, e);
        }
      }
    }

  /* ---------- 4. Invoices, bills, credit notes, vendor credits ---------- */
  const docTypes = [
    ["invoices", "customer", Invoice, "invoices", "invoiceNumber"],
    ["bills", "vendor", Bill, "bills", "billNumber"],
    ["creditNotes", "customer", CreditNote, "creditNotes", "number"],
    ["vendorCredits", "vendor", VendorCredit, "vendorCredits", "number"],
  ];
  for (const [type, kind, M, routeName, numField] of docTypes) {
    for (const d of data.records[type] || []) {
      progress();
      const label = `${d.number} ${d.party}`;
      const key = ref(type, `${d.number}|${d.party}`);
      try {
        if (d.status === "void") {
          R_(type).skipped++;
          warnings.push(`${label}: void in the source, not imported`);
          continue;
        }
        if (!d.date) throw new Error("Missing or unreadable date");
        if (!d.lines.length) throw new Error("No line items");
        const p = await party(kind, d.party, type, label);
        const numQ = { organization: ctx.org, [numField]: d.number, ...(type === "bills" ? { vendor: p._id } : {}) };
        if ((await M.exists({ organization: ctx.org, importRef: key })) || (d.number && (await M.exists(numQ)))) {
          R_(type).skipped++;
          continue;
        }
        const pos = d.placeOfSupply || p.placeOfSupply || org.state;
        // Make MGI's total match the source: put any difference in Adjustment.
        let adjustment = round2(d.adjustment || 0);
        if (d.total) {
          const t = computeTotals({ lineItems: d.lines, orgState: org.state, placeOfSupply: pos, shippingCharge: d.shippingCharge || 0, adjustment });
          const diff = round2(d.total - t.total);
          if (diff) {
            adjustment = round2(adjustment + diff);
            if (Math.abs(diff) > 1) warnings.push(`${label}: total differs from the source by ₹${diff} (mixed GST rates or charges); the difference is in Adjustment`);
          }
        }
        if (d.interState && pos === org.state) warnings.push(`${label}: IGST in the source but the customer/vendor is in your state — check place of supply`);
        const due = d.dueDate ? iso(d.dueDate) : iso(new Date(d.date.getTime() + (p.paymentTerms || 0) * 86400000));
        const body = {
          [kind]: String(p._id),
          date: iso(d.date),
          placeOfSupply: pos,
          lineItems: d.lines.map((l) => ({ ...l, item: null })),
          shippingCharge: d.shippingCharge || 0,
          adjustment,
          customerNotes: d.notes || "",
          terms: d.terms || "",
        };
        if (d.exchangeRate && p.currency && p.currency !== "INR") body.exchangeRate = d.exchangeRate;
        if (type === "invoices") Object.assign(body, { invoiceNumber: clean(d.number).slice(0, 40), dueDate: due < body.date ? body.date : due, status: d.status === "draft" ? "draft" : "sent" });
        if (type === "bills") Object.assign(body, { billNumber: clean(d.number) || `IMP-${iso(d.date)}`, dueDate: due < body.date ? body.date : due, status: d.status === "draft" ? "draft" : "open" });
        if (type === "creditNotes" || type === "vendorCredits") {
          Object.assign(body, { number: clean(d.number).slice(0, 40), status: d.status === "draft" ? "draft" : "open", reason: "Imported" });
          if (d.linked) {
            const L = type === "creditNotes" ? await Invoice.findOne({ organization: ctx.org, invoiceNumber: d.linked, customer: p._id }) : await Bill.findOne({ organization: ctx.org, billNumber: d.linked, vendor: p._id });
            if (L) body[type === "creditNotes" ? "invoice" : "bill"] = String(L._id);
          }
        }
        const doc = await call(R(routeName), "POST", "/", ctx, body);
        await M.updateOne({ _id: doc._id }, { importRef: key });
        R_(type).created++;
      } catch (e) {
        fail(type, label, e);
      }
    }
  }

  /* ---------- 5. Payments ---------- */
  const bankCode = (name) => {
    const code = lookupAccount(name);
    return code && ["Cash", "Bank"].includes(groupOfCode(code) || accounts.find((a) => a.code === code)?.group || (code === "cash" || code === "bank" ? "Bank" : "")) ? code : "";
  };
  await refreshAccounts();
  const freshAccounts = await chartOfAccounts(ctx.org);
  const isBank = (code) => freshAccounts.some((a) => a.code === code && ["Cash", "Bank"].includes(a.group));
  for (const [type, kind, M, routeName, DocM, docNum] of [
    ["payments", "customer", Payment, "payments", Invoice, "invoiceNumber"],
    ["vendorPayments", "vendor", VendorPayment, "vendorPayments", Bill, "billNumber"],
  ]) {
    for (const p of data.records[type] || []) {
      progress();
      const label = `${p.number || iso(p.date)} ${p.party}`;
      const key = ref(type, `${p.number}|${p.party}|${iso(p.date)}|${p.amount}`);
      try {
        if (!p.date) throw new Error("Missing date");
        if (!(p.amount > 0)) throw new Error("Amount must be more than zero");
        if (await M.exists({ organization: ctx.org, importRef: key })) {
          R_(type).skipped++;
          continue;
        }
        const party_ = await party(kind, p.party, type, label);
        let left = p.amount;
        const allocations = [];
        for (const a of p.allocations || []) {
          const d = await DocM.findOne({ organization: ctx.org, [docNum]: a.number, [kind]: party_._id });
          if (!d) {
            warnings.push(`${label}: ${kind === "customer" ? "invoice" : "bill"} ${a.number} not found, so that part stays as an advance`);
            continue;
          }
          const amt = round2(Math.min(a.amount, d.balance, left));
          if (amt > 0) {
            allocations.push({ [kind === "customer" ? "invoice" : "bill"]: String(d._id), amount: amt });
            left = round2(left - amt);
          }
        }
        // No bill-wise details in the source (Tally "On Account"): settle the oldest open documents first.
        if (!(p.allocations || []).length && left > 0) {
          const open = await DocM.find({ organization: ctx.org, [kind]: party_._id, balance: { $gt: 0 }, status: { $nin: ["draft", "void"] }, date: { $lte: p.date } }).sort({ date: 1 });
          for (const d of open) {
            const amt = round2(Math.min(d.balance, left));
            if (amt <= 0) break;
            allocations.push({ [kind === "customer" ? "invoice" : "bill"]: String(d._id), amount: amt });
            left = round2(left - amt);
          }
        }
        let bankAccount = "";
        const code = p.depositTo ? lookupAccount(p.depositTo) : "";
        if (code && isBank(code)) bankAccount = code;
        else if (p.depositTo && !/^(cash|bank)$/i.test(p.depositTo)) warnings.push(`${label}: "${p.depositTo}" isn't a cash/bank account in MGI, so the default ${p.mode === "cash" ? "Cash" : "Bank"} account was used`);
        const body = { [kind]: String(party_._id), date: iso(p.date), amount: p.amount, mode: p.mode || "bank_transfer", reference: (p.reference || p.number || "").slice(0, 100), bankAccount, allocations };
        if (p.exchangeRate && party_.currency && party_.currency !== "INR") body.exchangeRate = p.exchangeRate;
        const doc = await call(R(routeName), "POST", "/", ctx, body);
        await M.updateOne({ _id: doc._id }, { importRef: key });
        R_(type).created++;
      } catch (e) {
        fail(type, label, e);
      }
    }
  }
  void bankCode;

  /* ---------- 6. Expenses ---------- */
  for (const e of data.records.expenses || []) {
    progress();
    const label = `${iso(e.date)} ${e.account} ${e.amount}`;
    const key = ref("expense", `${iso(e.date)}|${e.account}|${e.amount}|${e.reference}|${e.vendor}`);
    try {
      if (await Expense.exists({ organization: ctx.org, importRef: key })) {
        R_("expenses").skipped++;
        continue;
      }
      let cats = await call(R("expenses"), "GET", "/categories", ctx);
      let category = cats.find((c) => c.toLowerCase() === e.account.toLowerCase());
      if (!category) {
        await Account.create({ organization: ctx.org, name: e.account, group: "Expense" });
        warnings.push(`Expense account "${e.account}" was created`);
        category = e.account;
      }
      const code = e.paidThrough ? lookupAccount(e.paidThrough) : "";
      const v = e.vendor ? contacts.vendor.get(e.vendor.toLowerCase()) || (await makeContact("vendor", { displayName: e.vendor })) : null;
      const doc = await call(R("expenses"), "POST", "/", ctx, {
        date: iso(e.date),
        category,
        amount: e.amount,
        taxRate: e.taxRate || 0,
        taxInclusive: !!e.taxInclusive,
        vendor: v ? String(v._id) : null,
        paidThrough: /cash/i.test(e.paidThrough) ? "cash" : "bank_transfer",
        bankAccount: code && isBank(code) ? code : "",
        reference: (e.reference || "").slice(0, 100),
        notes: e.notes || "",
      });
      await Expense.updateOne({ _id: doc._id }, { importRef: key });
      R_("expenses").created++;
    } catch (x) {
      fail("expenses", label, x);
    }
  }

  /* ---------- 7. Journals ---------- */
  for (const j of data.records.journals || []) {
    progress();
    const label = `${j.number} ${iso(j.date)}`;
    const key = ref("journal", `${j.number}|${iso(j.date)}`);
    try {
      if (!j.date) throw new Error("Missing date");
      if (await Journal.exists({ organization: ctx.org, importRef: key })) {
        R_("journals").skipped++;
        continue;
      }
      const missing = [];
      let touchesParty = false;
      const lines = j.lines.map((l) => {
        let code = lookupAccount(l.account);
        if (!code && (contacts.customer.has(l.account.toLowerCase()) || l.partyKind === "customer")) code = "ar";
        if (!code && (contacts.vendor.has(l.account.toLowerCase()) || l.partyKind === "vendor")) code = "ap";
        if (!code) missing.push(l.account);
        if (code === "ar" || code === "ap") touchesParty = true;
        return { account: code, description: l.party || "", debit: round2(l.debit), credit: round2(l.credit) };
      });
      if (missing.length) throw new Error(`Unknown account(s): ${[...new Set(missing)].join(", ")} — import the chart of accounts / Tally masters first`);
      const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
      const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
      if (Math.abs(dr - cr) > 0.05) throw new Error(`Debits ${dr} and credits ${cr} don't match`);
      if (touchesParty) warnings.push(`${label}: posts to receivables/payables directly — the totals are right, but it isn't linked to a customer's or vendor's balance`);
      let number = clean(j.number).slice(0, 40) || (await nextNumber(ctx.org, "journal", org.journalPrefix || "MJ-"));
      if (await Journal.exists({ organization: ctx.org, number })) number = `${number}-${String(Date.now()).slice(-4)}`;
      await Journal.create({ organization: ctx.org, number, date: j.date, reference: j.reference || "", notes: j.notes || "Imported journal", lines, total: dr, importRef: key });
      R_("journals").created++;
    } catch (e) {
      fail("journals", label, e);
    }
  }

  return { results, warnings: [...new Set(warnings)] };
}

module.exports = { commit, call };
