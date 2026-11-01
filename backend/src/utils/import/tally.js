/**
 * Tally ERP 9 / TallyPrime XML: masters (groups, ledgers) and vouchers (Day Book export).
 * Tally signs amounts the "deemed positive" way: debits are negative, credits positive.
 */
const C = require("./common");
const { clean, num, date, stateCode, gstin, gstTreatment, terms } = C;
const { mapGroup } = require("./sheets");

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return clean(v["#text"] ?? "");
  return clean(v);
};
const nameOf = (n) => text(n["@_NAME"]) || text(n.NAME) || text(arr(n["NAME.LIST"])[0]?.NAME) || text(arr(n["LANGUAGENAME.LIST"])[0]?.["NAME.LIST"]?.[0]?.NAME) || text(arr(arr(n["LANGUAGENAME.LIST"])[0]?.["NAME.LIST"])[0]?.NAME);

// Every node with tag `tag`, anywhere in the tree.
function collect(obj, tag, out = []) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === tag) arr(v).forEach((x) => typeof x === "object" && out.push(x));
    else if (typeof v === "object") arr(v).forEach((x) => collect(x, tag, out));
  }
  return out;
}

// Tally's predefined groups and where they sit (used when the export has no GROUP masters).
const RESERVED_PARENT = {
  "bank accounts": "current assets", "cash-in-hand": "current assets", "deposits (asset)": "current assets", "loans & advances (asset)": "current assets", "stock-in-hand": "current assets", "sundry debtors": "current assets",
  "duties & taxes": "current liabilities", "provisions": "current liabilities", "sundry creditors": "current liabilities", "bank od a/c": "loans (liability)", "secured loans": "loans (liability)", "unsecured loans": "loans (liability)", "reserves & surplus": "capital account",
};

function isTally(xml) {
  return collect(xml, "TALLYMESSAGE").length > 0 || collect(xml, "VOUCHER").length > 0 || collect(xml, "LEDGER").length > 0;
}

function normalise(xml) {
  const warnings = [];
  const groups = new Map(); // name(lower) → parent(lower)
  for (const g of collect(xml, "GROUP")) {
    const n = nameOf(g).toLowerCase();
    if (n) groups.set(n, text(g.PARENT).toLowerCase().replace(/^primary$/, ""));
  }
  // Walk up to the first group we know how to map.
  const resolve = (group) => {
    let g = clean(group).toLowerCase();
    for (let i = 0; i < 20 && g; i++) {
      const m = mapGroup(g);
      if (m) return m;
      g = groups.get(g) ?? RESERVED_PARENT[g] ?? "";
    }
    return null;
  };

  const out = { accounts: [], customers: [], vendors: [], invoices: [], bills: [], creditNotes: [], vendorCredits: [], payments: [], vendorPayments: [], journals: [] };
  const ledgerGroup = new Map(); // ledger name → MGI group / "debtors" / "creditors"
  for (const l of collect(xml, "LEDGER")) {
    const name = nameOf(l);
    if (!name) continue;
    const parent = text(l.PARENT);
    const grp = resolve(parent) || "Other Current Asset";
    ledgerGroup.set(name.toLowerCase(), grp);
    const ob = num(text(l.OPENINGBALANCE)); // Tally: negative = Dr
    if (grp === "debtors" || grp === "creditors") {
      const kind = grp === "debtors" ? "customer" : "vendor";
      const reg = arr(l["LEDGSTREGDETAILS.LIST"]).slice(-1)[0] || {};
      const mail = arr(l["LEDMAILINGDETAILS.LIST"]).slice(-1)[0] || {};
      const g = gstin(text(reg.GSTIN) || text(l.PARTYGSTIN) || text(l.GSTIN));
      const addr = [...arr(mail["ADDRESS.LIST"]), ...arr(l["ADDRESS.LIST"])].flatMap((x) => arr(x.ADDRESS)).map(text).filter(Boolean);
      const state = stateCode(text(mail.STATE) || text(l.LEDSTATENAME) || text(l.STATENAME) || text(reg.STATE), g);
      const bills = arr(l["BILLALLOCATIONS.LIST"]).map((b) => ({ number: text(b.NAME), date: date(text(b.BILLDATE)), amount: num(text(b.OPENINGBALANCE)) })).filter((b) => b.amount);
      out[kind === "customer" ? "customers" : "vendors"].push({
        kind,
        displayName: name,
        companyName: text(l.MAILINGNAME) || text(mail.MAILINGNAME) || "",
        email: text(l.EMAIL),
        phone: text(l.LEDGERMOBILE) || text(l.LEDGERPHONE),
        gstTreatment: gstTreatment(text(reg.GSTREGISTRATIONTYPE) || text(l.GSTREGISTRATIONTYPE), !!g, text(mail.COUNTRY) || text(l.COUNTRYNAME)),
        gstin: g,
        pan: text(l.INCOMETAXNUMBER),
        placeOfSupply: state,
        billingAddress: { street: addr.join(", "), city: "", state, pincode: text(mail.PINCODE) || text(l.PINCODE), country: text(mail.COUNTRY) || text(l.COUNTRYNAME) || "India" },
        paymentTerms: terms(text(l.BILLCREDITPERIOD)),
        currency: "",
        // Customers: Dr (negative in Tally) is receivable. Vendors: Cr (positive) is payable.
        opening: kind === "customer" ? -ob : ob,
        openingBills: bills.map((b) => ({ ...b, amount: kind === "customer" ? -b.amount : b.amount })),
      });
    } else {
      out.accounts.push({ name, code: text(l.ALIAS) || "", type: parent, group: grp, description: text(l.DESCRIPTION) || text(l.NARRATION), parent: "", opening: -ob });
    }
  }

  const groupOf = (ledger) => ledgerGroup.get(clean(ledger).toLowerCase());
  const isTax = (ledger) => /\b(c|s|i|ut)gst\b|cgst|sgst|igst|utgst|cess/i.test(ledger);
  const isRound = (ledger) => /round|rounding/i.test(ledger);

  for (const v of collect(xml, "VOUCHER")) {
    if (/yes/i.test(text(v.ISCANCELLED)) || /yes/i.test(text(v.ISOPTIONAL)) || /yes/i.test(text(v.ISDELETED))) continue;
    const vtype = (text(v.VOUCHERTYPENAME) || text(v["@_VCHTYPE"])).toLowerCase();
    const base = /credit note/.test(vtype) ? "credit note" : /debit note/.test(vtype) ? "debit note" : /sales|invoice/.test(vtype) ? "sales" : /purchase/.test(vtype) ? "purchase" : /receipt/.test(vtype) ? "receipt" : /payment/.test(vtype) ? "payment" : /contra/.test(vtype) ? "contra" : "journal";
    const d = date(text(v.DATE));
    const number = text(v.VOUCHERNUMBER) || text(v.REFERENCE) || `${vtype}-${text(v.DATE)}-${text(v["@_REMOTEID"]).slice(-6)}`;
    const entries = [...arr(v["ALLLEDGERENTRIES.LIST"]), ...arr(v["LEDGERENTRIES.LIST"])].map((e) => {
      const amt = num(text(e.AMOUNT));
      return { ledger: text(e.LEDGERNAME), debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0, bills: arr(e["BILLALLOCATIONS.LIST"]).map((b) => ({ name: text(b.NAME), type: text(b.BILLTYPE), amount: Math.abs(num(text(b.AMOUNT))) })) };
    });
    const inv = [...arr(v["ALLINVENTORYENTRIES.LIST"]), ...arr(v["INVENTORYENTRIES.LIST"])];
    // Inventory entries' accounting allocations (sales/purchase ledgers) are part of the entries.
    for (const it of inv)
      for (const a of arr(it["ACCOUNTINGALLOCATIONS.LIST"])) {
        const amt = num(text(a.AMOUNT));
        if (!entries.some((e) => e.ledger === text(a.LEDGERNAME))) entries.push({ ledger: text(a.LEDGERNAME), debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0, bills: [], fromInventory: true });
      }
    const partyName = text(v.PARTYLEDGERNAME) || text(v.PARTYNAME);
    const partyEntry = entries.find((e) => e.ledger === partyName) || entries.find((e) => ["debtors", "creditors"].includes(groupOf(e.ledger)));
    const pg = partyEntry ? groupOf(partyEntry.ledger) : null;
    const narration = text(v.NARRATION);

    const asJournal = () =>
      out.journals.push({
        number: `${text(v.VOUCHERTYPENAME) || "Journal"} ${number}`.trim(),
        date: d,
        reference: text(v.REFERENCE),
        notes: narration || `${text(v.VOUCHERTYPENAME)} ${number}`,
        lines: entries.filter((e) => e.debit || e.credit).map((e) => ({ account: e.ledger, debit: e.debit, credit: e.credit, partyKind: groupOf(e.ledger) === "debtors" ? "customer" : groupOf(e.ledger) === "creditors" ? "vendor" : "" })),
      });

    const asDoc = (kind, partyGroup) => {
      if (!partyEntry || pg !== partyGroup) return asJournal();
      const sales = kind === "invoices" || kind === "creditNotes";
      const total = partyEntry.debit || partyEntry.credit;
      const tax = entries.filter((e) => e.ledger !== partyEntry.ledger && isTax(e.ledger)).reduce((s, e) => s + e.debit + e.credit, 0);
      const igst = entries.some((e) => /igst/i.test(e.ledger) && (e.debit || e.credit));
      const incomeSide = entries.filter((e) => e.ledger !== partyEntry.ledger && !isTax(e.ledger) && !isRound(e.ledger) && ["Income", "Other Income", "Cost Of Goods Sold", "Expense", "Other Expense", "Fixed Asset"].includes(groupOf(e.ledger) || (e.fromInventory ? "Income" : "")));
      let lines = inv.map((it) => {
        const qtyText = text(it.BILLEDQTY) || text(it.ACTUALQTY);
        const qty = Math.abs(num(qtyText)) || 1;
        const amount = Math.abs(num(text(it.AMOUNT)));
        return { name: text(it.STOCKITEMNAME) || "Item", description: "", hsnSac: text(it.GSTHSNNAME) || text(it.HSNCODE) || "", unit: clean(qtyText.replace(/[-\d.,\s]+/, "")) || "", quantity: qty, rate: C.round2(amount / qty), discount: 0, taxRate: 0 };
      });
      if (!lines.length) lines = incomeSide.map((e) => ({ name: e.ledger, description: "", hsnSac: "", unit: "", quantity: 1, rate: C.round2(e.debit + e.credit), discount: 0, taxRate: 0 }));
      const taxable = lines.reduce((s, l) => s + l.quantity * l.rate, 0);
      const rate = taxable ? C.snapRate((tax / taxable) * 100) : 0;
      lines.forEach((l) => (l.taxRate = rate));
      // Freight, discounts, round-off and anything else become the adjustment, so totals match Tally.
      const other = entries.filter((e) => e.ledger !== partyEntry.ledger && !isTax(e.ledger) && !incomeSide.includes(e) && !e.fromInventory);
      const otherSigned = other.reduce((s, e) => s + (sales ? e.credit - e.debit : e.debit - e.credit), 0);
      out[kind].push({
        number,
        date: d,
        dueDate: null,
        party: partyEntry.ledger,
        status: sales ? "sent" : "open",
        placeOfSupply: "",
        interState: igst,
        lines,
        shippingCharge: 0,
        adjustment: C.round2(otherSigned),
        total: C.round2(total),
        notes: narration,
        linked: (partyEntry.bills.find((b) => /agst/i.test(b.type)) || {}).name || "",
      });
    };

    if (base === "sales") asDoc("invoices", "debtors");
    else if (base === "purchase") asDoc("bills", "creditors");
    else if (base === "credit note") asDoc("creditNotes", "debtors");
    else if (base === "debit note") asDoc("vendorCredits", "creditors");
    else if ((base === "receipt" && pg === "debtors") || (base === "payment" && pg === "creditors")) {
      const bank = entries.find((e) => e !== partyEntry && ["Bank", "Cash"].includes(groupOf(e.ledger))) || entries.find((e) => e !== partyEntry);
      const extra = entries.filter((e) => e !== partyEntry && e !== bank && (e.debit || e.credit));
      if (extra.length) warnings.push(`${text(v.VOUCHERTYPENAME)} ${number}: has more than a party and a bank line (${extra.map((e) => e.ledger).join(", ")}); imported as a journal`);
      if (extra.length) asJournal();
      else
        out[base === "receipt" ? "payments" : "vendorPayments"].push({
          number,
          date: d,
          party: partyEntry.ledger,
          amount: C.round2(partyEntry.debit || partyEntry.credit),
          mode: groupOf(bank?.ledger) === "Cash" ? "cash" : "bank_transfer",
          reference: text(v.REFERENCE) || narration.slice(0, 60),
          depositTo: bank?.ledger || "",
          allocations: partyEntry.bills.filter((b) => /agst/i.test(b.type) && b.name).map((b) => ({ number: b.name, amount: b.amount })),
        });
    } else asJournal();
  }
  return { records: out, ledgerGroup: Object.fromEntries(ledgerGroup), warnings };
}

module.exports = { isTally, normalise };
