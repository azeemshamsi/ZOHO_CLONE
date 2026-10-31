import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { stateName } from "../lib/constants";
import { PERIODS, periodRange, fmtRange, exportCsv } from "../lib/period";
import { PageHeader, Spinner } from "../components/ui";
import Icon from "../components/Icon";

/* ---------------- Period pickers ---------------- */
export function PeriodPicker({ value, onChange }) {
  return (
    <div className="period">
      <select
        className="select-inline"
        value={value.key}
        onChange={(e) => {
          const key = e.target.value;
          onChange(key === "custom" ? { ...value, key } : { key, ...periodRange(key) });
        }}
      >
        {PERIODS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {value.key === "custom" && (
        <>
          <input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </div>
  );
}

function AsOfPicker({ value, onChange }) {
  return (
    <div className="period">
      <span className="muted small">As of</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ---------------- Catalogue ---------------- */
export const REPORTS = [
  { key: "profit-and-loss", title: "Profit and Loss", group: "Business Overview", mode: "range", desc: "Income, cost of goods sold and expenses, and the profit left over." },
  { key: "balance-sheet", title: "Balance Sheet", group: "Business Overview", mode: "asof", desc: "What the business owns and owes on a given date." },
  { key: "sales-by-customer", title: "Sales by Customer", group: "Sales", mode: "range", desc: "Invoiced sales for each customer." },
  { key: "sales-by-item", title: "Sales by Item", group: "Sales", mode: "range", desc: "Quantity sold and sales value per item." },
  { key: "ar-aging", title: "Receivables Ageing", group: "Receivables & Payables", mode: "none", desc: "What customers owe, by how overdue it is." },
  { key: "ap-aging", title: "Payables Ageing", group: "Receivables & Payables", mode: "none", desc: "What you owe vendors, by how overdue it is." },
  { key: "expenses-by-category", title: "Expenses by Category", group: "Purchases & Expenses", mode: "range", desc: "Spending per expense account, including bills." },
  { key: "trial-balance", title: "Trial Balance", group: "Accountant", mode: "asof", desc: "Debit and credit totals of every account." },
  { key: "gstr1", title: "GSTR-1 Summary", group: "GST", mode: "range", period: "last_month", desc: "Outward supplies: B2B, B2C large & small, credit notes, HSN summary." },
  { key: "gstr3b", title: "GSTR-3B Summary", group: "GST", mode: "range", period: "last_month", desc: "Tax on sales, input tax credit and net GST payable." },
];

export function ReportsHome() {
  const groups = [...new Set(REPORTS.map((r) => r.group))];
  return (
    <>
      <PageHeader title="Reports" subtitle="Built from your invoices, bills, payments, expenses and journals." />
      <div className="report-grid">
        {groups.map((g) => (
          <div className="card" key={g}>
            <h3 className="report-group">{g}</h3>
            <ul className="report-links">
              {REPORTS.filter((r) => r.group === g).map((r) => (
                <li key={r.key}>
                  <Link to={`/reports/${r.key}`}>{r.title}</Link>
                  <span className="muted small">{r.desc}</span>
                </li>
              ))}
              {g === "Accountant" && (
                <li>
                  <Link to="/chart-of-accounts">Account Transactions</Link>
                  <span className="muted small">Pick an account to see every entry with a running balance.</span>
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- Report page ---------------- */
export function ReportPage() {
  const { key } = useParams();
  const meta = REPORTS.find((r) => r.key === key);
  const { organization } = useAuth();
  const [range, setRange] = useState(() => ({ key: meta?.period || "this_fy", ...periodRange(meta?.period || "this_fy") }));
  const [asOf, setAsOf] = useState(isoDate());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const paper = useRef(null);

  useEffect(() => {
    setRange({ key: meta?.period || "this_fy", ...periodRange(meta?.period || "this_fy") });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!meta) return;
    setData(null);
    setError("");
    const params = meta.mode === "range" ? { from: range.from, to: range.to } : meta.mode === "asof" ? { to: asOf } : {};
    api
      .get(`/reports/${key}`, { params })
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e)));
  }, [key, meta, range.from, range.to, asOf]);

  if (!meta) return <p>Report not found.</p>;
  const subtitle = meta.mode === "range" ? fmtRange(range.from, range.to) : meta.mode === "asof" ? `As of ${date(asOf)}` : `As of ${date(new Date())}`;
  const Body = BODIES[key];

  return (
    <>
      <PageHeader title={meta.title} back="/reports">
        {meta.mode === "range" && <PeriodPicker value={range} onChange={setRange} />}
        {meta.mode === "asof" && <AsOfPicker value={asOf} onChange={setAsOf} />}
        <button className="btn" onClick={() => paper.current && exportCsv(paper.current, `${meta.title} ${subtitle}`)}>
          Export CSV
        </button>
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
      </PageHeader>
      {error && <div className="alert alert-error">{error}</div>}
      {!data ? (
        !error && <Spinner />
      ) : (
        <div className="report-paper" ref={paper}>
          <div className="report-head">
            <div className="muted">{organization?.name}</div>
            <h2>{meta.title}</h2>
            <div className="muted small">{subtitle}</div>
          </div>
          <Body d={data} range={meta.mode === "range" ? range : { from: "2000-01-01", to: asOf }} />
        </div>
      )}
    </>
  );
}

/* ---------------- Report bodies ---------------- */
const acctLink = (code, range) =>
  code && !code.startsWith("_") ? `/chart-of-accounts/${encodeURIComponent(code)}?from=${range.from}&to=${range.to}` : null;

function Section({ title, sec, range, totalLabel }) {
  return (
    <>
      <tr className="row-section">
        <td colSpan={2}>{title}</td>
      </tr>
      {sec.rows.map((r) => (
        <tr key={r.code}>
          <td className="indent">{acctLink(r.code, range) ? <Link to={acctLink(r.code, range)}>{r.name}</Link> : r.name}</td>
          <td className="num">{money(r.amount)}</td>
        </tr>
      ))}
      {!sec.rows.length && (
        <tr>
          <td className="indent muted">No entries</td>
          <td />
        </tr>
      )}
      <tr className="row-subtotal">
        <td>{totalLabel || `Total for ${title}`}</td>
        <td className="num">{money(sec.total)}</td>
      </tr>
    </>
  );
}

function ProfitLoss({ d, range }) {
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Total</th>
        </tr>
      </thead>
      <tbody>
        <Section title="Operating Income" sec={d.operatingIncome} range={range} />
        <Section title="Cost of Goods Sold" sec={d.cogs} range={range} />
        <tr className="row-total">
          <td>Gross Profit</td>
          <td className="num">{money(d.grossProfit)}</td>
        </tr>
        <Section title="Operating Expense" sec={d.operatingExpense} range={range} />
        <tr className="row-total">
          <td>Operating Profit</td>
          <td className="num">{money(d.operatingProfit)}</td>
        </tr>
        <Section title="Non Operating Income" sec={d.otherIncome} range={range} />
        <Section title="Non Operating Expense" sec={d.otherExpense} range={range} />
        <tr className="row-grand">
          <td>Net Profit / Loss</td>
          <td className={`num ${d.netProfit < 0 ? "text-overdue" : "text-paid"}`}>{money(d.netProfit)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function BalanceSheet({ d, range }) {
  return (
    <>
      {!d.balanced && <div className="alert alert-error">Assets and liabilities + equity don't match. Please tell us — this shouldn't happen.</div>}
      <table className="report-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="row-head">
            <td colSpan={2}>Assets</td>
          </tr>
          <Section title="Current Assets" sec={d.currentAssets} range={range} />
          <Section title="Fixed Assets" sec={d.fixedAssets} range={range} />
          <tr className="row-total">
            <td>Total Assets</td>
            <td className="num">{money(d.totalAssets)}</td>
          </tr>
          <tr className="row-head">
            <td colSpan={2}>Liabilities & Equity</td>
          </tr>
          <Section title="Current Liabilities" sec={d.currentLiabilities} range={range} />
          <Section title="Long Term Liabilities" sec={d.longTermLiabilities} range={range} />
          <tr className="row-subtotal">
            <td>Total Liabilities</td>
            <td className="num">{money(d.totalLiabilities)}</td>
          </tr>
          <Section title="Equity" sec={d.equity} range={range} />
          <tr className="row-total">
            <td>Total Liabilities & Equity</td>
            <td className="num">{money(d.totalLiabilitiesAndEquity)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function TrialBalance({ d, range }) {
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Type</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.code}>
            <td>
              <Link to={acctLink(r.code, range)}>{r.name}</Link>
            </td>
            <td className="muted">{r.group}</td>
            <td className="num">{r.debit ? money(r.debit) : ""}</td>
            <td className="num">{r.credit ? money(r.credit) : ""}</td>
          </tr>
        ))}
        <tr className="row-grand">
          <td colSpan={2}>Total</td>
          <td className="num">{money(d.totalDebit)}</td>
          <td className="num">{money(d.totalCredit)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Aging({ d, kind }) {
  const cols = [
    ["current", "Current"],
    ["d1_15", "1–15 Days"],
    ["d16_30", "16–30 Days"],
    ["d31_45", "31–45 Days"],
    ["d45plus", "> 45 Days"],
    ["total", "Total"],
  ];
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>{kind === "ar" ? "Customer Name" : "Vendor Name"}</th>
          {cols.map(([, l]) => (
            <th key={l} className="num">
              {l}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/${kind === "ar" ? "customers" : "vendors"}/${r.id}`}>{r.name}</Link>
            </td>
            {cols.map(([k]) => (
              <td key={k} className={`num ${k !== "current" && k !== "total" && r[k] ? "text-overdue" : ""}`}>
                {money(r[k])}
              </td>
            ))}
          </tr>
        ))}
        {!d.rows.length && (
          <tr>
            <td colSpan={7} className="muted center">
              Nothing outstanding
            </td>
          </tr>
        )}
        <tr className="row-grand">
          <td>Total</td>
          {cols.map(([k]) => (
            <td key={k} className="num">
              {money(d.totals[k])}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function SalesByCustomer({ d }) {
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Customer Name</th>
          <th className="num">Invoice Count</th>
          <th className="num">Sales</th>
          <th className="num">Sales With Tax</th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/customers/${r.id}`}>{r.name}</Link>
            </td>
            <td className="num">{r.count}</td>
            <td className="num">{money(r.sales)}</td>
            <td className="num">{money(r.salesWithTax)}</td>
          </tr>
        ))}
        <tr className="row-grand">
          <td>Total</td>
          <td className="num">{d.totals.count}</td>
          <td className="num">{money(d.totals.sales)}</td>
          <td className="num">{money(d.totals.salesWithTax)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function SalesByItem({ d }) {
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Item Name</th>
          <th>HSN/SAC</th>
          <th className="num">Quantity Sold</th>
          <th className="num">Amount</th>
          <th className="num">Average Price</th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r, i) => (
          <tr key={i}>
            <td>{r.name}</td>
            <td className="mono">{r.hsnSac}</td>
            <td className="num">
              {r.quantity} {r.unit}
            </td>
            <td className="num">{money(r.amount)}</td>
            <td className="num">{money(r.averagePrice)}</td>
          </tr>
        ))}
        <tr className="row-grand">
          <td colSpan={2}>Total</td>
          <td className="num">{d.totals.quantity}</td>
          <td className="num">{money(d.totals.amount)}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

function ExpensesByCategory({ d, range }) {
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Type</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.code}>
            <td>
              <Link to={acctLink(r.code, range)}>{r.name}</Link>
            </td>
            <td className="muted">{r.group}</td>
            <td className="num">{money(r.amount)}</td>
          </tr>
        ))}
        <tr className="row-grand">
          <td colSpan={2}>Total</td>
          <td className="num">{money(d.total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

const TAX_COLS = [
  ["taxable", "Taxable Value"],
  ["igst", "IGST"],
  ["cgst", "CGST"],
  ["sgst", "SGST"],
];

function DocTable({ title, sec, cols, link }) {
  return (
    <>
      <h3 className="report-sub">
        {title} <span className="muted small">({sec.count})</span>
      </h3>
      <table className="report-table">
        <thead>
          <tr>
            {cols.map(([, l]) => (
              <th key={l}>{l}</th>
            ))}
            {TAX_COLS.map(([, l]) => (
              <th key={l} className="num">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sec.rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([k]) => (
                <td key={k}>
                  {k === "number" && link ? <Link to={link(r)}>{r.number}</Link> : k === "date" ? date(r.date) : k === "placeOfSupply" ? `${r.placeOfSupply}-${stateName(r.placeOfSupply)}` : k === "rate" ? `${r.rate}%` : r[k]}
                </td>
              ))}
              {TAX_COLS.map(([k]) => (
                <td key={k} className="num">
                  {money(r[k])}
                </td>
              ))}
            </tr>
          ))}
          {!sec.rows.length && (
            <tr>
              <td colSpan={cols.length + 4} className="muted center">
                None
              </td>
            </tr>
          )}
          <tr className="row-subtotal">
            <td colSpan={cols.length}>Total</td>
            {TAX_COLS.map(([k]) => (
              <td key={k} className="num">
                {money(sec[k])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </>
  );
}

function Gstr1({ d }) {
  const inv = (r) => `/invoices/${r.id}`;
  const cn = (r) => `/credit-notes/${r.id}`;
  return (
    <>
      {!d.gstin && <div className="alert alert-error">Add your GSTIN in Settings before filing.</div>}
      <p className="muted small">
        {d.documents.invoices} invoices and {d.documents.creditNotes} credit notes in this period. Drafts and void documents are left out.
      </p>
      <DocTable title="4A · B2B Invoices (to registered customers)" sec={d.b2b} link={inv} cols={[["number", "Invoice#"], ["date", "Date"], ["name", "Customer"], ["gstin", "GSTIN"], ["placeOfSupply", "Place of Supply"]]} />
      <DocTable title="5 · B2C Large (inter-state, over ₹1 lakh, unregistered)" sec={d.b2cl} link={inv} cols={[["number", "Invoice#"], ["date", "Date"], ["name", "Customer"], ["placeOfSupply", "Place of Supply"]]} />
      <DocTable title="7 · B2C Small (by place of supply and rate)" sec={d.b2cs} cols={[["placeOfSupply", "Place of Supply"], ["rate", "Rate"]]} />
      <DocTable title="9B · Credit Notes – Registered (CDNR)" sec={d.cdnr} link={cn} cols={[["number", "Credit Note#"], ["date", "Date"], ["name", "Customer"], ["gstin", "GSTIN"], ["invoiceNumber", "Invoice#"]]} />
      <DocTable title="9B · Credit Notes – Unregistered (CDNUR)" sec={d.cdnur} link={cn} cols={[["number", "Credit Note#"], ["date", "Date"], ["name", "Customer"], ["invoiceNumber", "Invoice#"]]} />
      <DocTable title="12 · HSN-wise Summary of Outward Supplies" sec={d.hsn} cols={[["hsn", "HSN/SAC"], ["unit", "UQC"], ["quantity", "Quantity"], ["rate", "Rate"]]} />
      <p className="muted small">This is a summary to help you or your CA file GSTR-1. Check it against the GST portal before filing.</p>
    </>
  );
}

function Gstr3b({ d }) {
  const row = (label, o, taxable = true) => (
    <tr>
      <td>{label}</td>
      <td className="num">{taxable && o.taxable !== undefined ? money(o.taxable) : ""}</td>
      <td className="num">{money(o.igst)}</td>
      <td className="num">{money(o.cgst)}</td>
      <td className="num">{money(o.sgst)}</td>
    </tr>
  );
  return (
    <>
      <h3 className="report-sub">3.1 · Outward Supplies</h3>
      <table className="report-table">
        <thead>
          <tr>
            <th>Nature of Supplies</th>
            <th className="num">Taxable Value</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
          </tr>
        </thead>
        <tbody>
          {row("(a) Outward taxable supplies (net of credit notes)", d.outward)}
          {row("(c) Nil rated and exempted supplies", { ...d.nilExempt, igst: 0, cgst: 0, sgst: 0 })}
        </tbody>
      </table>
      <h3 className="report-sub">4 · Eligible Input Tax Credit</h3>
      <table className="report-table">
        <thead>
          <tr>
            <th>Details</th>
            <th className="num" />
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
          </tr>
        </thead>
        <tbody>
          {row("ITC on bills", d.itcBills, false)}
          {row("ITC on expenses", d.itcExpenses, false)}
          <tr className="row-subtotal">
            <td>(A)(5) All other ITC</td>
            <td />
            <td className="num">{money(d.itc.igst)}</td>
            <td className="num">{money(d.itc.cgst)}</td>
            <td className="num">{money(d.itc.sgst)}</td>
          </tr>
        </tbody>
      </table>
      <h3 className="report-sub">Net GST Position</h3>
      <table className="report-table">
        <thead>
          <tr>
            <th />
            <th className="num" />
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
          </tr>
        </thead>
        <tbody>
          {row("Tax on outward supplies", d.outward, false)}
          {row("Less: input tax credit", d.itc, false)}
          <tr className="row-grand">
            <td>Net payable (negative = credit to carry forward)</td>
            <td />
            {["igst", "cgst", "sgst"].map((k) => (
              <td key={k} className={`num ${d.net[k] < 0 ? "text-paid" : ""}`}>
                {money(d.net[k])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Simplified view: the GST portal sets off IGST credit first against IGST, then CGST and SGST, so the final cash payable can differ. ITC includes
        all GST on bills and expenses; exclude blocked credits (e.g. food, personal vehicles) when filing. Check with your CA before filing.
      </p>
    </>
  );
}

const BODIES = {
  "profit-and-loss": ProfitLoss,
  "balance-sheet": BalanceSheet,
  "trial-balance": TrialBalance,
  "ar-aging": (p) => <Aging {...p} kind="ar" />,
  "ap-aging": (p) => <Aging {...p} kind="ap" />,
  "sales-by-customer": SalesByCustomer,
  "sales-by-item": SalesByItem,
  "expenses-by-category": ExpensesByCategory,
  gstr1: Gstr1,
  gstr3b: Gstr3b,
};
