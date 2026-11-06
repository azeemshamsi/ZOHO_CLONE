/**
 * Input tax credit (ITC) from the books, month by month, beside GSTR-2B where it has been uploaded.
 * Input GST ledgers: the built-in Input CGST / SGST / IGST and ledgers named like them (Tally's "Input CGST 9%",
 * "ITC IGST" …). Per month:
 *   taken  — ITC booked on purchases (bills, expenses, less vendor credits) and journals debiting input GST
 *   used   — journals crediting input GST (set-off against output tax in GSTR-3B, reversals)
 *   2B     — ITC available per the uploaded GSTR-2B (lines marked ITC available, credit notes negative)
 * Balance = ITC left in the input GST ledgers (to use against output tax).
 */
const { chartOfAccounts, buildEntries } = require("./ledger");
const Gstr2b = require("../models/Gstr2b");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const IST = 5.5 * 3600000;
const SYSTEM = { input_cgst: "cgst", input_sgst: "sgst", input_igst: "igst" };

function inputHead(a) {
  if (SYSTEM[a.code]) return SYSTEM[a.code];
  const n = String(a.name || "").toLowerCase();
  if (!/input|\bitc\b/.test(n) || /output|payable|reverse charge payable/.test(n)) return null;
  if (/igst/.test(n)) return "igst";
  if (/cgst/.test(n)) return "cgst";
  if (/sgst|utgst/.test(n)) return "sgst";
  if (/cess/.test(n)) return "cess";
  return null;
}

const monthKey = (d) => {
  const t = new Date(new Date(d).getTime() + IST);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};
const fyOf = (d = new Date()) => {
  const t = new Date(new Date(d).getTime() + IST);
  return t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
};
const zero = () => ({ cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 });
const addTo = (o, head, v) => {
  o[head] = r2(o[head] + v);
  o.total = r2(o.total + v);
};

async function itcSummary(org, { fy = fyOf() } = {}) {
  const accounts = await chartOfAccounts(org);
  const heads = new Map(accounts.map((a) => [a.code, inputHead(a)]).filter(([, h]) => h));
  const entries = await buildEntries(org, {});
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;
    const y = m >= 4 ? fy : fy + 1;
    months.push({ key: `${y}-${String(m).padStart(2, "0")}`, label: new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), taken: zero(), used: zero(), b2b: null });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));
  const balance = zero();
  const opening = zero(); // before the financial year
  const fyStart = new Date(Date.UTC(fy, 3, 1) - IST);
  for (const e of entries) {
    const m = byKey.get(monthKey(e.date));
    for (const l of e.lines) {
      const h = heads.get(l.account);
      if (!h) continue;
      const net = l.debit - l.credit;
      addTo(balance, h, net);
      if (new Date(e.date) < fyStart) addTo(opening, h, net);
      if (!m) continue;
      if (e.type === "Journal") {
        if (l.debit) addTo(m.taken, h, l.debit);
        if (l.credit) addTo(m.used, h, l.credit);
      } else addTo(m.taken, h, net);
    }
  }
  // GSTR-2B uploaded for these months.
  const stmts = await Gstr2b.find({ organization: org, period: { $in: months.map((m) => m.key) } }, { period: 1, docs: 1 }).lean();
  for (const s of stmts) {
    const m = byKey.get(s.period);
    if (!m) continue;
    const t = zero();
    for (const d of s.docs || []) {
      if (d.itc === false) continue;
      addTo(t, "igst", Number(d.iamt) || 0);
      addTo(t, "cgst", Number(d.camt) || 0);
      addTo(t, "sgst", Number(d.samt) || 0);
    }
    m.b2b = t;
  }
  for (const m of months) m.diff = m.b2b ? r2(m.taken.total - m.b2b.total) : null;
  const fyTaken = zero();
  const fyUsed = zero();
  for (const m of months) for (const h of ["cgst", "sgst", "igst", "cess"]) (addTo(fyTaken, h, m.taken[h]), addTo(fyUsed, h, m.used[h]));
  const now = monthKey(new Date());
  const last = months.filter((m) => m.key < now && m.b2b).slice(-1)[0] || null;
  const risk = (await require("./bills180").bills180(org).catch(() => null))?.summary || null;
  return {
    fy: `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`,
    ledgers: accounts.filter((a) => heads.has(a.code)).map((a) => ({ code: a.code, name: a.name, head: heads.get(a.code) })),
    opening,
    balance,
    fyTaken,
    fyUsed,
    thisMonth: byKey.get(now) || null,
    lastWith2b: last ? { key: last.key, label: last.label, books: last.taken.total, b2b: last.b2b.total, diff: last.diff } : null,
    months,
    risk180: risk ? { count: risk.over.count, itc: risk.over.itc, soonCount: risk.soon.count, soonItc: risk.soon.itc } : null,
  };
}

module.exports = { itcSummary, inputHead, fyOf };
