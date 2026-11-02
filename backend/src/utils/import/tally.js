/**
 * Tally ERP 9 / TallyPrime XML: masters (groups, ledgers) and vouchers (Day Book export).
 * Tally signs amounts the "deemed positive" way: debits are negative, credits positive.
 */
const C = require("./common");
const { clean, num, date, stateCode, gstin, gstTreatment, terms } = C;
const { mapGroup } = require("./sheets");

// Unit rate with enough decimals that quantity × rate gives back Tally's amount to the paisa.
const rate6 = (r) => Math.round(r * 1e6) / 1e6;
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

// GST rate per line. Tally keeps one tax ledger per rate ("IGST 5%", "Input CGST 9%"), so a voucher
// with goods at 5% and 18% says how much tax each rate carries; pick the rate of each line so the
// tax per rate matches. Without rates in the ledger names, look for the rates that make the total match.
const STD_RATES = [0, 5, 12, 18, 28];
function lineRates(amounts, taxes) {
  const n = amounts.length;
  const total = C.round2(taxes.reduce((s, t) => s + t.amount, 0));
  const taxable = amounts.reduce((s, a) => s + a, 0);
  const byRate = new Map();
  let named = taxes.length > 0;
  for (const t of taxes) {
    const m = t.ledger.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m || /cess/i.test(t.ledger)) {
      named = false;
      break;
    }
    const r = C.round2(Number(m[1]) * (/igst/i.test(t.ledger) ? 1 : /cgst|sgst|utgst/i.test(t.ledger) ? 2 : 1));
    byRate.set(r, C.round2((byRate.get(r) || 0) + t.amount));
  }
  const taxOf = (a, r) => C.round2((a * r) / 100);
  const single = taxable ? C.snapRate((total / taxable) * 100) : 0;
  const errOf = (rates) => {
    if (named) {
      const got = new Map();
      rates.forEach((r, i) => r && got.set(r, (got.get(r) || 0) + taxOf(amounts[i], r)));
      let e = 0;
      for (const r of new Set([...byRate.keys(), ...got.keys()])) e += Math.abs((got.get(r) || 0) - (byRate.get(r) || 0));
      return e;
    }
    return Math.abs(rates.reduce((s, r, i) => s + taxOf(amounts[i], r), 0) - total);
  };
  const tol = 0.05 + 0.02 * n;
  const flat = Array(n).fill(named && byRate.size === 1 ? [...byRate.keys()][0] : single);
  if (!n || errOf(flat) <= tol) return flat;
  const cands = named ? [...new Set([...byRate.keys(), 0])] : STD_RATES;
  let best = flat;
  let bestErr = errOf(flat);
  if (cands.length ** n <= 200000) {
    const cur = Array(n).fill(0);
    const walk = (i) => {
      if (bestErr <= 0.01) return;
      if (i === n) {
        const e = errOf(cur);
        if (e < bestErr - 0.005) [best, bestErr] = [[...cur], e];
        return;
      }
      for (const r of cands) {
        cur[i] = r;
        walk(i + 1);
      }
    };
    walk(0);
  } else if (named) {
    // Too many lines to try every mix: biggest lines first, each to the rate with the most taxable value left.
    const need = new Map([...byRate].map(([r, t]) => [r, r ? (t * 100) / r : 0]));
    const out = Array(n).fill(0);
    [...amounts.keys()].sort((x, y) => amounts[y] - amounts[x]).forEach((i) => {
      let pick = 0;
      let room = amounts[i] * 0.5;
      for (const [r, left] of need) if (r && left > room) [pick, room] = [r, left];
      out[i] = pick;
      if (pick) need.set(pick, need.get(pick) - amounts[i]);
    });
    if (errOf(out) < bestErr) best = out;
  }
  return best;
}

function isTally(xml) {
  return collect(xml, "TALLYMESSAGE").length > 0 || collect(xml, "VOUCHER").length > 0 || collect(xml, "LEDGER").length > 0;
}

function normalise(xml, known = {}) {
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
  // Is `group` (a ledger's parent) Stock-in-Hand or under it?
  const underStock = (group) => {
    let g = clean(group).toLowerCase();
    for (let i = 0; i < 20 && g; i++) {
      if (g === "stock-in-hand") return true;
      g = groups.get(g) ?? RESERVED_PARENT[g] ?? "";
    }
    return false;
  };
  const stockLedgers = [];
  const billMismatch = [];
  const billPartial = [];

  const out = { accounts: [], customers: [], vendors: [], invoices: [], bills: [], creditNotes: [], vendorCredits: [], payments: [], vendorPayments: [], journals: [], stockAdjustments: [] };
  const ledgerGroup = new Map(); // ledger name → OrdexaGo group / "debtors" / "creditors"
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
      let bills = arr(l["BILLALLOCATIONS.LIST"]).map((b) => ({ number: text(b.NAME), date: date(text(b.BILLDATE)), amount: num(text(b.OPENINGBALANCE)) })).filter((b) => b.amount);
      // Tally's bill-wise details can be stale (bills never knocked off, a wrong amount). The ledger's
      // opening balance is what the trial balance uses. When the bills cover only part of it, keep them and
      // add the rest as an opening amount without a bill; when they don't fit at all, use the ledger alone.
      const billSum = C.round2(bills.reduce((s, b) => s + b.amount, 0));
      const rest = C.round2(ob - billSum);
      if (bills.length && Math.abs(rest) > 1) {
        const partOf = bills.every((b) => Math.sign(b.amount) === Math.sign(ob)) && Math.abs(billSum) < Math.abs(ob);
        if (partOf) {
          bills.push({ number: "", date: null, amount: rest });
          billPartial.push(`${name} (₹${Math.abs(rest).toLocaleString("en-IN")})`);
        } else {
          billMismatch.push(`${name} (bills ₹${Math.abs(billSum).toLocaleString("en-IN")}, ledger ₹${Math.abs(ob).toLocaleString("en-IN")})`);
          bills = [];
        }
      }
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
      // Stock-in-Hand ledgers (Opening Stock, Closing Stock): with inventory kept item-wise their value
      // comes from the stock items (Stock Summary import), so a ledger balance here would count stock twice.
      const stock = underStock(parent);
      if (stock && ob) stockLedgers.push(name);
      out.accounts.push({ name, code: text(l.ALIAS) || "", type: parent, group: grp, description: text(l.DESCRIPTION) || text(l.NARRATION), parent: "", opening: stock ? 0 : -ob });
    }
  }

  // Ledgers already in OrdexaGo (e.g. masters imported earlier) count when this file has no masters.
  for (const [name, g] of Object.entries(known.ledgers || {})) if (!ledgerGroup.has(name)) ledgerGroup.set(name, g);
  const groupOf = (ledger) => ledgerGroup.get(clean(ledger).toLowerCase());
  const isTax = (ledger) => /\b(c|s|i|ut)gst\b|cgst|sgst|igst|utgst|cess/i.test(ledger);
  const isRound = (ledger) => /round|rounding/i.test(ledger);

  const guessed = new Set();
  const twoWay = new Set();
  const stockOnly = [];
  for (const v of collect(xml, "VOUCHER")) {
    if (/yes/i.test(text(v.ISCANCELLED)) || /yes/i.test(text(v.ISOPTIONAL)) || /yes/i.test(text(v.ISDELETED))) continue;
    const vtype = (text(v.VOUCHERTYPENAME) || text(v["@_VCHTYPE"])).toLowerCase();
    const base = /credit note/.test(vtype) ? "credit note" : /debit note/.test(vtype) ? "debit note" : /sales|invoice/.test(vtype) ? "sales" : /purchase/.test(vtype) ? "purchase" : /receipt/.test(vtype) ? "receipt" : /payment/.test(vtype) ? "payment" : /contra/.test(vtype) ? "contra" : "journal";
    const d = date(text(v.DATE));
    const number = text(v.VOUCHERNUMBER) || text(v.REFERENCE) || `${vtype}-${text(v.DATE)}-${text(v["@_REMOTEID"]).slice(-6)}`;
    // Tally vouchers can have no number at all (manual numbering left blank): OrdexaGo numbers those
    // invoices/credit notes as INV01, INV02… (CN01… for credit notes); `number` stays as the import key.
    const autoNumber = !text(v.VOUCHERNUMBER) && !text(v.REFERENCE);
    const entries = [...arr(v["ALLLEDGERENTRIES.LIST"]), ...arr(v["LEDGERENTRIES.LIST"])].map((e) => {
      const amt = num(text(e.AMOUNT));
      return { ledger: text(e.LEDGERNAME), debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0, bills: arr(e["BILLALLOCATIONS.LIST"]).map((b) => ({ name: text(b.NAME), type: text(b.BILLTYPE), amount: Math.abs(num(text(b.AMOUNT))) })) };
    });
    const inv = [...arr(v["ALLINVENTORYENTRIES.LIST"]), ...arr(v["INVENTORYENTRIES.LIST"])];
    // Inventory entries' accounting allocations (sales/purchase ledgers) are part of the entries.
    // Several stock lines usually share one sales/purchase ledger: add their amounts together.
    const alloc = new Map();
    for (const it of inv)
      for (const a of arr(it["ACCOUNTINGALLOCATIONS.LIST"])) {
        const name = text(a.LEDGERNAME);
        if (!name || entries.some((e) => e.ledger === name && !e.fromInventory)) continue;
        alloc.set(name, (alloc.get(name) || 0) + num(text(a.AMOUNT)));
      }
    for (const [name, amt] of alloc) entries.push({ ledger: name, debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0, bills: [], fromInventory: true });
    const partyName = text(v.PARTYLEDGERNAME) || text(v.PARTYNAME);
    const partyEntry = entries.find((e) => e.ledger === partyName) || entries.find((e) => ["debtors", "creditors"].includes(groupOf(e.ledger)));
    let pg = partyEntry ? groupOf(partyEntry.ledger) : null;
    // No masters for the party: on a sales/purchase voucher the party ledger is the customer/vendor,
    // unless it's a known bank/cash/income/expense ledger (cash sales etc.).
    if (partyEntry && !pg && partyEntry.ledger === partyName && !isTax(partyName) && !/\bbank\b|\bcash\b|a\/c\b|account|card/i.test(partyName)) {
      if (["sales", "credit note"].includes(base)) pg = "debtors";
      else if (["purchase", "debit note"].includes(base)) pg = "creditors";
      if (pg) {
        ledgerGroup.set(partyName.toLowerCase(), pg);
        guessed.add(`${partyName} (${pg === "debtors" ? "customer" : "vendor"})`);
      }
    }
    // Stock-only vouchers (stock journal, manufacturing, delivery/receipt notes) have no accounting effect here.
    const stockType = /stock|manufactur|delivery note|receipt note|physical|rejection|material/.test(vtype);
    const drSum = entries.reduce((t, e) => t + e.debit, 0);
    const crSum = entries.reduce((t, e) => t + e.credit, 0);
    if (!entries.some((e) => e.debit || e.credit) || (stockType && Math.abs(drSum - crSum) > 0.05)) {
      // Stock moves: items in (produced / transferred to) and out (consumed / transferred from).
      const move = (list, sign) =>
        list.map((it) => {
          const qtyText = text(it.ACTUALQTY) || text(it.BILLEDQTY);
          const qty = Math.abs(num(qtyText));
          const amount = Math.abs(num(text(it.AMOUNT)));
          return { name: text(it.STOCKITEMNAME), unit: clean(qtyText.replace(/[-\d.,\s]+/, "")).toLowerCase(), quantity: sign * qty, rate: qty ? C.round2(amount / qty) : 0, godown: text(it.GODOWNNAME) || text(arr(it["BATCHALLOCATIONS.LIST"])[0]?.GODOWNNAME) };
        });
      const lines = [
        ...move(arr(v["INVENTORYENTRIESIN.LIST"]), 1),
        ...move(arr(v["INVENTORYENTRIESOUT.LIST"]), -1),
        ...move(inv.filter((it) => /yes/i.test(text(it.ISDEEMEDPOSITIVE))), 1),
        ...move(inv.filter((it) => !/yes/i.test(text(it.ISDEEMEDPOSITIVE))), -1),
      ].filter((l) => l.name && l.quantity);
      if (lines.length) {
        const kind = /manufactur/.test(vtype) ? "Manufacturing" : /physical/.test(vtype) ? "Stocktaking results" : "Stock journal";
        out.stockAdjustments.push({ number: `${text(v.VOUCHERTYPENAME) || "Stock Journal"} ${number}`.trim(), date: d, reason: kind, notes: text(v.NARRATION) || `${text(v.VOUCHERTYPENAME)} ${number} (Tally)`, lines });
      } else stockOnly.push(`${text(v.VOUCHERTYPENAME) || "Voucher"} ${number}`);
      continue;
    }
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
      // A party can be both (sister concern / branch kept under Sundry Creditors but also sold to):
      // a sales voucher still makes an invoice; the importer creates the matching customer if needed.
      if (!partyEntry || !["debtors", "creditors"].includes(pg)) return asJournal();
      if (pg !== partyGroup) twoWay.add(`${partyEntry.ledger} (${partyGroup === "debtors" ? "also a customer" : "also a vendor"})`);
      const sales = kind === "invoices" || kind === "creditNotes";
      const total = partyEntry.debit || partyEntry.credit;
      const igst = entries.some((e) => /igst/i.test(e.ledger) && (e.debit || e.credit));
      const localTax = entries.some((e) => /cgst|sgst|utgst/i.test(e.ledger) && (e.debit || e.credit));
      // Where the voucher says the supply went (marketplace sales go all over India under one party).
      // Purchases follow the vendor's state, as OrdexaGo works out GST on bills from it.
      const partyState = stateCode(text(v.STATENAME) || text(v.PARTYSTATENAME));
      const supplyState = stateCode(text(v.PLACEOFSUPPLY) || text(v.CONSIGNEESTATENAME)) || partyState;
      const docState = sales ? supplyState : partyState || supplyState;
      const incomeSide = entries.filter((e) => e.ledger !== partyEntry.ledger && !isTax(e.ledger) && !isRound(e.ledger) && ["Income", "Other Income", "Cost Of Goods Sold", "Expense", "Other Expense", "Fixed Asset"].includes(groupOf(e.ledger) || (e.fromInventory ? "Income" : "")));
      let lines = inv.map((it) => {
        const qtyText = text(it.BILLEDQTY) || text(it.ACTUALQTY);
        const qty = Math.abs(num(qtyText)) || 1;
        const amount = Math.abs(num(text(it.AMOUNT)));
        const ledger = text(arr(it["ACCOUNTINGALLOCATIONS.LIST"])[0]?.LEDGERNAME);
        return { name: text(it.STOCKITEMNAME) || "Item", description: "", hsnSac: text(it.GSTHSNNAME) || text(it.HSNCODE) || "", unit: clean(qtyText.replace(/[-\d.,\s]+/, "")).toLowerCase() || "", quantity: qty, rate: rate6(amount / qty), discount: 0, taxRate: 0, stock: !!text(it.STOCKITEMNAME), ...(ledger ? { ledger } : {}) };
      });
      const ledgerLine = (e, amt) => ({ name: e.ledger, description: "", hsnSac: "", unit: "", quantity: 1, rate: C.round2(amt), discount: 0, taxRate: 0, ledger: e.ledger });
      if (!lines.length) lines = incomeSide.map((e) => ledgerLine(e, e.debit + e.credit));
      // Purchases: expense ledgers on the voucher (advertising, shipping, freight, commission…) are bill lines
      // posted to their own account, not an adjustment. Unknown ledgers are treated as expenses too.
      const purchaseLedger = (e) => {
        const g = groupOf(e.ledger);
        return !g || ["Expense", "Other Expense", "Cost Of Goods Sold", "Fixed Asset"].includes(g);
      };
      if (!sales && inv.length)
        for (const e of entries) {
          const amt = (kind === "bills" ? e.debit - e.credit : e.credit - e.debit);
          if (e === partyEntry || isTax(e.ledger) || isRound(e.ledger) || e.fromInventory || amt <= 0 || !purchaseLedger(e)) continue;
          lines.push(ledgerLine(e, amt));
          e.asLine = true;
        }
      if (!sales && !inv.length)
        for (const e of entries) {
          const amt = (kind === "bills" ? e.debit - e.credit : e.credit - e.debit);
          if (e === partyEntry || isTax(e.ledger) || isRound(e.ledger) || incomeSide.includes(e) || amt <= 0 || groupOf(e.ledger)) continue;
          lines.push(ledgerLine(e, amt));
          e.asLine = true;
        }
      const taxes = entries.filter((e) => e.ledger !== partyEntry.ledger && isTax(e.ledger) && (e.debit || e.credit)).map((e) => ({ ledger: e.ledger, amount: Math.abs(e.debit - e.credit) }));
      const rates = lineRates(lines.map((l) => C.round2(l.quantity * l.rate)), taxes);
      lines.forEach((l, i) => (l.taxRate = rates[i]));
      // Freight, discounts, round-off and anything else become the adjustment, so totals match Tally.
      const other = entries.filter((e) => e.ledger !== partyEntry.ledger && !isTax(e.ledger) && !incomeSide.includes(e) && !e.fromInventory && !e.asLine && (e.debit || e.credit));
      const otherSigned = other.reduce((s, e) => s + (sales ? e.credit - e.debit : e.debit - e.credit), 0);
      // When the whole adjustment is one real ledger (TDS deducted on a bill), post it there instead of Rounding.
      const adjLedgers = [...new Set(other.filter((e) => !isRound(e.ledger)).map((e) => e.ledger))];
      const roundOff = other.filter((e) => isRound(e.ledger)).reduce((s, e) => s + Math.abs(e.debit - e.credit), 0);
      const adjustmentLedger = !sales && adjLedgers.length === 1 && roundOff < 1 ? adjLedgers[0] : "";
      const roundSigned = other.filter((e) => isRound(e.ledger)).reduce((t, e) => t + (sales ? e.credit - e.debit : e.debit - e.credit), 0);
      out[kind].push({
        number,
        date: d,
        dueDate: null,
        party: partyEntry.ledger,
        status: sales ? "sent" : "open",
        placeOfSupply: docState,
        partyState,
        interState: igst,
        localTax,
        lines,
        shippingCharge: 0,
        adjustment: C.round2(otherSigned),
        adjustmentLedger,
        adjustmentRoundOff: adjustmentLedger ? C.round2(roundSigned) : 0,
        autoNumber,
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
  if (billPartial.length) warnings.push(`${billPartial.length} party ledger(s) have bill-wise opening details in Tally covering only part of the opening balance; the bills were kept and the rest added as an opening amount without a bill: ${billPartial.slice(0, 10).join(", ")}${billPartial.length > 10 ? "…" : ""}`);
  if (billMismatch.length) warnings.push(`${billMismatch.length} party ledger(s) have bill-wise opening details in Tally that don't add up to the ledger's opening balance, so the ledger balance was used as one opening amount: ${billMismatch.slice(0, 10).join(", ")}${billMismatch.length > 10 ? "…" : ""}`);
  if (stockLedgers.length) warnings.push(`Opening balance on stock ledger(s) ${stockLedgers.join(", ")} was left out: stock value comes from your items' opening stock (import Tally's Stock Summary), so it isn't counted twice`);
  if (stockOnly.length) warnings.push(`${stockOnly.length} voucher(s) with neither accounting entries nor stock lines were skipped: ${stockOnly.slice(0, 8).join(", ")}${stockOnly.length > 8 ? "…" : ""}`);
  if (twoWay.size) warnings.push(`${twoWay.size} party ledger(s) are used on both sides (sold to and bought from), so they get both a customer and a vendor record: ${[...twoWay].slice(0, 8).join(", ")}`);
  if (guessed.size) warnings.push(`${guessed.size} party ledger(s) weren't in the file or in OrdexaGo and were taken from the voucher type: ${[...guessed].slice(0, 10).join(", ")}${guessed.size > 10 ? "…" : ""}`);
  return { records: out, ledgerGroup: Object.fromEntries(ledgerGroup), warnings };
}

module.exports = { isTally, normalise, lineRates };
