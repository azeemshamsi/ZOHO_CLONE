/**
 * Spreadsheet datasets: Zoho Books exports (CSV/XLSX), Tally Excel lists, and MGI's templates.
 * Each dataset says which headers identify it and turns rows into MGI-shaped records.
 */
const C = require("./common");
const { pick, clean, num, date, stateCode, gstin, gstTreatment, terms, mode, key } = C;

const A = {
  accountName: ["account name", "account", "ledger name", "ledger", "name", "particulars", "account head"],
  accountType: ["account type", "type", "group", "under", "parent group", "group name", "primary group", "account group"],
  accountCode: ["account code", "code", "alias", "account number"],
  parentAccount: ["parent account", "parent account name"],
  description: ["description", "notes", "narration"],
  opening: ["opening balance", "opening balance (dr)", "opening bal", "op bal", "opening", "balance"],
  debit: ["debit", "dr", "debit amount", "debit (inr)", "debit amount (inr)", "dr amount"],
  credit: ["credit", "cr", "credit amount", "credit (inr)", "credit amount (inr)", "cr amount"],
  contactName: ["display name", "customer name", "vendor name", "contact name", "party name", "name", "company name", "customer", "vendor", "supplier name", "supplier", "ledger name"],
  companyName: ["company name", "company"],
  contactType: ["contact type", "type", "customer sub type", "group", "under"],
  email: ["emailid", "email", "email id", "e mail", "email address", "primary email"],
  phone: ["phone", "mobilephone", "mobile", "mobile phone", "phone number", "contact number", "mobile number", "work phone"],
  gstTreatment: ["gst treatment", "registration type", "gst registration type", "gst type"],
  gstin: ["gst identification number (gstin)", "gstin", "gstin/uin", "gstin uin", "gst number", "gst no", "gst in", "gstin number"],
  pos: ["place of supply", "place of supply code", "place of contact", "place of contact(with state code)", "billing state", "state", "state name"],
  street: ["billing address", "billing street", "billing street1", "address", "address line 1", "address 1", "street"],
  street2: ["billing street2", "address line 2", "address 2"],
  city: ["billing city", "city", "town"],
  pin: ["billing code", "billing zip", "billing zip code", "pincode", "pin code", "pin", "zip", "zip code", "postal code"],
  country: ["billing country", "country"],
  paymentTerms: ["payment terms", "payment terms label", "credit period", "credit days", "terms"],
  currency: ["currency code", "currency"],
  pan: ["pan", "pan number", "it pan"],
  date: ["date", "invoice date", "bill date", "credit note date", "vendor credit date", "journal date", "expense date", "payment date", "voucher date", "txn date"],
  dueDate: ["due date"],
  invoiceNumber: ["invoice number", "invoice#", "invoice no", "invoice no.", "voucher no", "voucher number", "bill no"],
  billNumber: ["bill number", "bill#", "bill no", "supplier invoice no", "vendor invoice number", "reference number"],
  cnNumber: ["credit note number", "creditnote number", "credit note#", "credit note no"],
  vcNumber: ["vendor credit number", "vendor credit#", "debit note number", "debit note no"],
  status: ["invoice status", "bill status", "credit note status", "status"],
  itemName: ["item name", "item", "product name", "product", "description of goods", "particulars", "item desc"],
  itemDesc: ["item desc", "item description", "line description"],
  hsn: ["hsn/sac", "hsn sac", "hsn", "sac", "hsn code", "hsn/sac code"],
  qty: ["quantity", "qty", "billed qty"],
  unit: ["usage unit", "unit", "uom", "units"],
  rate: ["item price", "rate", "price", "unit price", "selling price", "item rate"],
  discount: ["discount(%)", "item discount", "discount %", "discount percentage", "line discount %"],
  taxRate: ["item tax %", "item tax1 %", "tax %", "tax percentage", "gst rate", "gst %", "tax rate", "gst rate (%)", "igst rate"],
  itemTotal: ["item total", "line total", "amount", "taxable value", "taxable amount"],
  shipping: ["shipping charge", "shipping charges", "freight"],
  adjustment: ["adjustment", "round off", "rounding"],
  total: ["total", "invoice total", "bill total", "total amount", "grand total", "amount"],
  exchangeRate: ["exchange rate"],
  notes: ["notes", "customer notes", "narration"],
  termsText: ["terms & conditions", "terms and conditions"],
  paymentNumber: ["payment number", "payment#", "payment no", "receipt no", "receipt number"],
  paymentMode: ["mode", "payment mode", "paid via", "payment method"],
  reference: ["reference number", "reference#", "reference", "ref no", "utr", "cheque number"],
  appliedInvoice: ["invoice number", "invoice#", "invoice no"],
  appliedBill: ["bill number", "bill#", "bill no"],
  appliedAmount: ["amount applied to invoice", "amount applied to bill", "invoice payment applied", "bill payment applied", "applied amount", "amount applied", "payment applied amount"],
  amount: ["amount", "payment amount", "amount received", "amount paid", "total"],
  depositTo: ["deposit to", "paid through", "deposited to", "bank account", "account"],
  expenseAccount: ["expense account", "category", "expense category", "account"],
  paidThrough: ["paid through", "paid from", "payment account"],
  vendorName: ["vendor name", "vendor", "supplier", "merchant"],
  journalNumber: ["journal number", "journal#", "journal no", "entry number", "voucher no"],
  contactOnLine: ["contact name", "customer name", "vendor name"],
  linkedInvoice: ["associated invoice number", "invoice number reference", "against invoice", "reference invoice number"],
  linkedBill: ["associated bill number", "against bill"],
};

const H = (headers, list) => C.hasCol(headers, list);

// Which dataset is this sheet? (headers are already key()-normalised)
function detect(headers, fileName = "") {
  const f = fileName.toLowerCase();
  const has = (...lists) => lists.every((l) => H(headers, l));
  if (has(A.cnNumber)) return "creditNotes";
  if (has(A.vcNumber)) return "vendorCredits";
  if (has(A.paymentNumber) && (H(headers, ["vendor name", "vendor"]) || /vendor|payments? made|supplier/.test(f))) return "vendorPayments";
  if (has(A.paymentNumber)) return "payments";
  if (H(headers, ["expense account", "expense category"])) return "expenses";
  if (H(headers, ["bill number", "bill date", "bill#"]) && has(A.itemName)) return "bills";
  if (H(headers, ["invoice number", "invoice date", "invoice#"]) && (has(A.itemName) || has(A.qty))) return "invoices";
  if (H(headers, ["journal date", "journal number", "journal#"])) return "journals";
  if (has(A.accountName, A.debit, A.credit) && H(headers, A.date)) return "journals";
  if (has(A.accountName, A.debit, A.credit)) return "openingBalances";
  if (H(headers, ["account type", "account code", "parent account"])) return "accounts";
  if (H(headers, ["under", "group", "parent group", "primary group"]) && H(headers, ["name", "ledger name", "particulars", "ledger"])) return "accounts"; // Tally ledger list
  if (H(headers, A.gstin) || H(headers, A.email) || H(headers, ["display name", "customer name", "vendor name", "contact name", "billing city"])) {
    if (/vendor|supplier|creditor/.test(f) || H(headers, ["vendor name", "supplier name"])) return "vendors";
    return "customers";
  }
  return null;
}

/* ---------------- account groups ---------------- */
const ZOHO_TYPES = {
  "other current asset": "Other Current Asset", "other asset": "Other Current Asset", "input tax": "Other Current Asset", "stock": "Other Current Asset", "cash": "Cash", "bank": "Bank",
  "fixed asset": "Fixed Asset", "accounts receivable": "Accounts Receivable", "other current liability": "Other Current Liability", "credit card": "Other Current Liability",
  "long term liability": "Long Term Liability", "other liability": "Other Current Liability", "output tax": "Other Current Liability", "accounts payable": "Accounts Payable",
  "equity": "Equity", "income": "Income", "other income": "Other Income", "expense": "Expense", "cost of goods sold": "Cost Of Goods Sold", "other expense": "Other Expense", "payment clearing": "Other Current Asset",
  "overseas tax payable": "Other Current Liability", "deferred tax asset": "Other Current Asset", "deferred tax liability": "Long Term Liability", "loans and advances": "Other Current Asset",
};
// Tally's predefined groups → MGI group ("debtors"/"creditors" become customers/vendors).
const TALLY_GROUPS = {
  "capital account": "Equity", "reserves & surplus": "Equity", "reserves and surplus": "Equity", "retained earnings": "Equity",
  "current assets": "Other Current Asset", "bank accounts": "Bank", "cash-in-hand": "Cash", "cash in hand": "Cash", "deposits (asset)": "Other Current Asset", "loans & advances (asset)": "Other Current Asset",
  "stock-in-hand": "Other Current Asset", "sundry debtors": "debtors", "current liabilities": "Other Current Liability", "duties & taxes": "Other Current Liability", "duties and taxes": "Other Current Liability",
  "provisions": "Other Current Liability", "sundry creditors": "creditors", "fixed assets": "Fixed Asset", "investments": "Other Current Asset", "loans (liability)": "Long Term Liability",
  "bank od a/c": "Other Current Liability", "bank od accounts": "Other Current Liability", "secured loans": "Long Term Liability", "unsecured loans": "Long Term Liability", "sales accounts": "Income",
  "purchase accounts": "Cost Of Goods Sold", "direct incomes": "Income", "direct expenses": "Cost Of Goods Sold", "indirect incomes": "Other Income", "indirect expenses": "Expense",
  "branch / divisions": "Other Current Liability", "suspense a/c": "Other Current Asset", "misc. expenses (asset)": "Other Current Asset", "misc expenses (asset)": "Other Current Asset",
  "income (direct)": "Income", "income (indirect)": "Other Income", "expenses (direct)": "Cost Of Goods Sold", "expenses (indirect)": "Expense",
};
function mapGroup(type) {
  const t = clean(type).toLowerCase();
  if (!t) return null;
  if (ZOHO_TYPES[t]) return ZOHO_TYPES[t];
  if (TALLY_GROUPS[t]) return TALLY_GROUPS[t];
  // Loose matches for custom names
  if (/debtor|receivable/.test(t)) return "debtors";
  if (/creditor|payable/.test(t)) return "creditors";
  if (/bank od|overdraft/.test(t)) return "Other Current Liability";
  if (/bank/.test(t)) return "Bank";
  if (/cash/.test(t)) return "Cash";
  if (/fixed|asset.*fixed|plant|machinery|furniture|vehicle/.test(t)) return "Fixed Asset";
  if (/duties|tax|gst|tds|provision|current liab/.test(t)) return "Other Current Liability";
  if (/loan.*liab|secured|unsecured|long term/.test(t)) return "Long Term Liability";
  if (/capital|equity|reserve|surplus/.test(t)) return "Equity";
  if (/purchase|cost of goods|direct exp/.test(t)) return "Cost Of Goods Sold";
  if (/indirect inc|other inc/.test(t)) return "Other Income";
  if (/sales|income|revenue/.test(t)) return "Income";
  if (/expense|indirect/.test(t)) return "Expense";
  if (/asset|deposit|advance|stock|investment/.test(t)) return "Other Current Asset";
  return null;
}

/* ---------------- normalisers ---------------- */
function openingFor(kind, v) {
  const s = clean(v);
  if (!s) return 0;
  const marked = /\b(dr|cr)\.?$/i.test(s);
  const n = num(s, { drcr: true }); // Dr +, Cr −
  if (kind === "vendor") return marked ? -n : Math.abs(n) * (n < 0 ? -1 : 1);
  return n;
}

function contact(r, kind) {
  const g = gstin(pick(r, A.gstin));
  const country = clean(pick(r, A.country));
  const street = [clean(pick(r, A.street)), clean(pick(r, A.street2))].filter(Boolean).join(", ");
  const pos = stateCode(pick(r, A.pos), g);
  const ob = num(pick(r, A.opening), { drcr: true });
  return {
    kind,
    displayName: clean(pick(r, A.contactName)),
    companyName: clean(pick(r, A.companyName)),
    email: clean(pick(r, A.email)).split(/[,;\s]/)[0],
    phone: clean(pick(r, A.phone)),
    gstTreatment: gstTreatment(pick(r, A.gstTreatment), !!g, country),
    gstin: g,
    pan: clean(pick(r, A.pan)).toUpperCase(),
    placeOfSupply: pos,
    billingAddress: { street, city: clean(pick(r, A.city)), state: pos, pincode: clean(pick(r, A.pin)).replace(/\s/g, ""), country: country || "India" },
    paymentTerms: terms(pick(r, A.paymentTerms)),
    currency: clean(pick(r, A.currency)).toUpperCase().slice(0, 3) || "",
    // Customers: amount receivable. Vendors: amount payable. With a Dr/Cr marker (Tally), Cr means we owe.
    opening: openingFor(kind, pick(r, A.opening)),
  };
}

const groupBy = (rows, f) => {
  const m = new Map();
  for (const r of rows) {
    const k = clean(f(r));
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

function docStatus(v, isPurchase) {
  const s = clean(v).toLowerCase();
  if (/draft/.test(s)) return "draft";
  if (/void|cancel/.test(s)) return "void";
  return isPurchase ? "open" : "sent";
}

function lines(rows) {
  return rows
    .map((r) => {
      const qty = num(pick(r, A.qty)) || 1;
      let rate = num(pick(r, A.rate));
      const lineTotal = num(pick(r, ["item total", "line total", "taxable value", "taxable amount"]));
      if (!rate && lineTotal) rate = lineTotal / qty;
      let tr = pick(r, A.taxRate);
      tr = clean(tr) === "" ? null : num(tr);
      const taxAmt = num(pick(r, ["item tax amount", "item tax", "tax amount"]));
      if (tr === null && taxAmt && lineTotal) tr = (taxAmt / lineTotal) * 100;
      return {
        name: clean(pick(r, A.itemName)) || "Item",
        description: clean(pick(r, A.itemDesc)),
        hsnSac: clean(pick(r, A.hsn)).replace(/\s/g, ""),
        unit: clean(pick(r, A.unit)),
        quantity: qty,
        rate: C.round2(rate),
        discount: num(pick(r, A.discount)),
        taxRate: C.snapRate(tr || 0),
      };
    })
    .filter((l) => l.rate || l.name !== "Item");
}

function doc(numberAliases, partyAliases, isPurchase) {
  return (rows) =>
    [...groupBy(rows, (r) => pick(r, numberAliases))].map(([number, rs]) => {
      const f = rs[0];
      const d = date(pick(f, A.date));
      return {
        number,
        date: d,
        dueDate: date(pick(f, A.dueDate)),
        party: clean(pick(f, partyAliases)),
        partyGstin: gstin(pick(f, A.gstin)),
        status: docStatus(pick(f, A.status), isPurchase),
        placeOfSupply: stateCode(pick(f, A.pos), gstin(pick(f, A.gstin))),
        currency: clean(pick(f, A.currency)).toUpperCase().slice(0, 3),
        exchangeRate: num(pick(f, A.exchangeRate)) || null,
        shippingCharge: num(pick(f, A.shipping)),
        adjustment: num(pick(f, A.adjustment)),
        total: num(pick(f, ["total", "invoice total", "bill total", "total amount", "grand total"])) || null,
        notes: clean(pick(f, A.notes)),
        terms: clean(pick(f, A.termsText)),
        linked: clean(pick(f, isPurchase ? A.linkedBill : A.linkedInvoice)),
        lines: lines(rs),
      };
    });
}

function payments(isVendor) {
  const partyA = isVendor ? ["vendor name", "vendor", "supplier name", "party name"] : ["customer name", "customer", "party name", "contact name"];
  const applied = isVendor ? A.appliedBill : A.appliedInvoice;
  return (rows) =>
    [...groupBy(rows, (r) => pick(r, A.paymentNumber) || `${clean(pick(r, A.date))}|${clean(pick(r, partyA))}|${clean(pick(r, A.amount))}|${clean(pick(r, A.reference))}`)].map(([number, rs]) => {
      const f = rs[0];
      return {
        number,
        date: date(pick(f, A.date)),
        party: clean(pick(f, partyA)),
        amount: num(pick(f, ["amount", "payment amount", "amount received", "amount paid"])),
        mode: mode(pick(f, A.paymentMode)),
        reference: clean(pick(f, A.reference)),
        depositTo: clean(pick(f, ["deposit to", "paid through", "deposited to", "bank account", "paid from"])),
        currency: clean(pick(f, A.currency)).toUpperCase().slice(0, 3),
        exchangeRate: num(pick(f, A.exchangeRate)) || null,
        allocations: rs.map((r) => ({ number: clean(pick(r, applied)), amount: num(pick(r, A.appliedAmount)) })).filter((a) => a.number && a.amount > 0),
      };
    });
}

const NORMALISE = {
  accounts: (rows) =>
    rows
      .map((r) => {
        const type = clean(pick(r, A.accountType));
        const name = clean(pick(r, A.accountName));
        const d = num(pick(r, A.debit));
        const c = num(pick(r, A.credit));
        const ob = clean(pick(r, A.opening)) ? num(pick(r, A.opening), { drcr: true }) : C.round2(d - c);
        return { name, code: clean(pick(r, A.accountCode)), type, group: mapGroup(type), description: clean(pick(r, A.description)), parent: clean(pick(r, A.parentAccount)), opening: ob, raw: r };
      })
      .filter((a) => a.name),
  customers: (rows) => rows.map((r) => contact(r, "customer")).filter((c) => c.displayName),
  vendors: (rows) => rows.map((r) => contact(r, "vendor")).filter((c) => c.displayName),
  invoices: doc(A.invoiceNumber, ["customer name", "customer", "party name", "billing name"], false),
  bills: doc(["bill number", "bill#", "bill no", "supplier invoice no", "vendor invoice number"], ["vendor name", "vendor", "supplier name", "supplier", "party name"], true),
  creditNotes: doc(A.cnNumber, ["customer name", "customer", "party name"], false),
  vendorCredits: doc(A.vcNumber, ["vendor name", "vendor", "supplier name", "party name"], true),
  payments: payments(false),
  vendorPayments: payments(true),
  expenses: (rows) =>
    rows
      .map((r) => ({
        date: date(pick(r, A.date)),
        account: clean(pick(r, ["expense account", "expense category", "category", "account"])),
        amount: num(pick(r, ["amount", "expense amount", "total"])),
        taxRate: C.snapRate(num(pick(r, A.taxRate))),
        taxInclusive: /inclusive/i.test(clean(pick(r, ["is inclusive tax", "tax type", "amount is"]))) || clean(pick(r, ["is inclusive tax"])).toLowerCase() === "true",
        vendor: clean(pick(r, A.vendorName)),
        paidThrough: clean(pick(r, A.paidThrough)),
        reference: clean(pick(r, A.reference)),
        notes: clean(pick(r, ["description", "notes"])),
      }))
      .filter((e) => e.date && e.amount > 0),
  journals: (rows) =>
    [...groupBy(rows, (r) => pick(r, A.journalNumber) || `${clean(pick(r, A.date))}|${clean(pick(r, ["reference number", "reference"]))}`)].map(([number, rs]) => {
      const f = rs[0];
      return {
        number,
        date: date(pick(f, A.date)),
        reference: clean(pick(f, ["reference number", "reference#", "reference"])),
        notes: clean(pick(f, ["notes", "narration", "description"])),
        lines: rs.map((r) => ({ account: clean(pick(r, ["account", "account name", "ledger", "ledger name", "particulars"])), debit: num(pick(r, A.debit)), credit: num(pick(r, A.credit)), party: clean(pick(r, A.contactOnLine)) })).filter((l) => l.account && (l.debit || l.credit)),
      };
    }),
  openingBalances: (rows) =>
    rows
      .map((r) => ({ account: clean(pick(r, A.accountName)), type: clean(pick(r, A.accountType)), debit: num(pick(r, A.debit)), credit: num(pick(r, A.credit)) }))
      .filter((r) => r.account && (r.debit || r.credit) && !/^(grand )?total$/i.test(r.account)),
};

const ALL_ALIASES = new Set(Object.values(A).flat().map(key));

module.exports = { detect, NORMALISE, mapGroup, ALL_ALIASES, A };
