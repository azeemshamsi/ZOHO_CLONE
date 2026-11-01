import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { stateName } from "../lib/constants";
import { PERIODS, periodRange, fmtRange, exportCsv } from "../lib/period";
import { PageHeader, Spinner, Status } from "../components/ui";
import { docLink } from "./Accounts";
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
const R = (key, title, group, mode, desc, extra = {}) => ({ key, title, group, mode, desc, ...extra });
export const REPORTS = [
  // Business Overview
  R("profit-and-loss", "Profit and Loss", "Business Overview", "range", "Income, cost of goods sold and expenses, and the profit left over."),
  R("pl-schedule-iii", "Profit and Loss (Schedule III)", "Business Overview", "range", "Statement of profit and loss in the Companies Act format."),
  R("horizontal-pl", "Horizontal Profit and Loss", "Business Overview", "range", "Expenses and income side by side (T-format)."),
  R("cash-flow", "Cash Flow Statement", "Business Overview", "range", "Where cash came from and went: operating, investing, financing."),
  R("balance-sheet", "Balance Sheet", "Business Overview", "asof", "What the business owns and owes on a given date."),
  R("horizontal-bs", "Horizontal Balance Sheet", "Business Overview", "asof", "Liabilities and assets side by side (T-format)."),
  R("bs-schedule-iii", "Balance Sheet (Schedule III)", "Business Overview", "asof", "Balance sheet in the Companies Act format."),
  R("ratios", "Business Performance Ratios", "Business Overview", "range", "Liquidity, profitability, solvency and efficiency ratios."),
  R("movement-of-equity", "Movement of Equity", "Business Overview", "range", "Opening, additions, reductions and closing equity."),
  // Sales
  R("sales-by-customer", "Sales by Customer", "Sales", "range", "Invoiced sales for each customer."),
  R("sales-by-item", "Sales by Item", "Sales", "range", "Quantity sold and sales value per item."),
  R("sales-summary", "Sales Summary", "Sales", "range", "Sales, tax and credit notes month by month."),
  // Receivables
  R("customer-balances", "Customer Balances", "Receivables", "none", "Invoiced, received, credits and balance due per customer."),
  R("ar-aging", "AR Aging Summary", "Receivables", "none", "What customers owe, by how overdue it is."),
  R("ar-aging-details", "AR Aging Details", "Receivables", "none", "Every unpaid invoice with its age."),
  R("invoice-details", "Invoice Details", "Receivables", "range", "All invoices in the period with status and balance."),
  R("quote-details", "Quote Details", "Receivables", "range", "All quotes in the period."),
  R("sales-order-details", "Sales Order Details", "Receivables", "range", "All sales orders in the period."),
  R("credit-note-details", "Credit Note Details", "Receivables", "range", "All credit notes and their remaining credit."),
  // Payments Received
  R("payments-received", "Payments Received", "Payments Received", "range", "Customer payments with mode, reference and invoices settled."),
  // Payables
  R("vendor-balances", "Vendor Balances", "Payables", "none", "Billed, paid, credits and balance due per vendor."),
  R("ap-aging", "AP Aging Summary", "Payables", "none", "What you owe vendors, by how overdue it is."),
  R("ap-aging-details", "AP Aging Details", "Payables", "none", "Every unpaid bill with its age."),
  R("bill-details", "Bill Details", "Payables", "range", "All bills in the period with status and balance."),
  R("purchase-order-details", "Purchase Order Details", "Payables", "range", "All purchase orders in the period."),
  R("vendor-credit-details", "Vendor Credit Details", "Payables", "range", "All vendor credits and their remaining credit."),
  R("payments-made", "Payments Made", "Payables", "range", "Vendor payments with mode, reference and bills settled."),
  // Purchases and Expenses
  R("purchases-by-vendor", "Purchases by Vendor", "Purchases and Expenses", "range", "Billed purchases for each vendor."),
  R("purchases-by-item", "Purchases by Item", "Purchases and Expenses", "range", "Quantity bought and cost per item."),
  R("expenses-by-category", "Expenses by Category", "Purchases and Expenses", "range", "Spending per expense account, including bills."),
  R("expenses-by-vendor", "Expenses by Vendor", "Purchases and Expenses", "range", "Bills and expenses grouped by vendor."),
  R("expense-details", "Expense Details", "Purchases and Expenses", "range", "Every recorded expense with GST."),
  // Taxes
  R("gstr1", "GSTR-1 Summary", "Taxes", "range", "Outward supplies: B2B, B2C large & small, credit notes, HSN summary.", { period: "last_month" }),
  R("gstr3b", "GSTR-3B Summary", "Taxes", "range", "Tax on sales, input tax credit and net GST payable.", { period: "last_month" }),
  R("tax-summary", "Tax Summary", "Taxes", "range", "Output and input GST by tax rate."),
  // Inventory
  R("inventory-summary", "Inventory Summary", "Inventory", "range", "Opening, in, out, on hand, committed and available stock per item."),
  R("inventory-valuation", "Inventory Valuation Summary", "Inventory", "asof", "Stock on hand and its FIFO value on a date."),
  R("fifo-cost-lots", "FIFO Cost Lot Tracking", "Inventory", "asof", "Each lot of stock still on hand, with its cost."),
  R("stock-movement", "Stock Movement", "Inventory", "range", "Every stock in and out, item by item."),
  R("product-sales", "Product Sales Report", "Inventory", "range", "Quantity sold, sales, cost and margin per item."),
  R("committed-stock", "Committed Stock Details", "Inventory", "none", "Stock promised on confirmed sales orders."),
  R("reorder-report", "Reorder Report", "Inventory", "none", "Items at or below their reorder level."),
  // Projects and Timesheet
  R("project-summary", "Project Summary", "Projects and Timesheet", "none", "Budget vs logged hours, billed and unbilled per project."),
  R("timesheet-details", "Timesheet Details", "Projects and Timesheet", "range", "Every time entry with its status and billable amount."),
  R("unbilled-time", "Unbilled Time", "Projects and Timesheet", "none", "Billable time not yet invoiced, by customer."),
  // Recurring
  R("recurring-profiles", "Recurring Profiles", "Recurring", "none", "Recurring invoices, bills and expenses with their schedules."),
  // Activity
  R("email-log", "Emails Sent", "Activity", "range", "Documents and reminders emailed from MGI."),
  // Banking
  R("reconciliation-status", "Reconciliation Status", "Banking", "none", "Books vs bank balance and lines still to match, per account."),
  // Accountant
  R("account-transactions", "Account Transactions", "Accountant", "link", "Pick an account to see every entry with a running balance.", { to: "/chart-of-accounts" }),
  R("budget-vs-actuals", "Budget vs Actuals", "Accountant", "link", "Compare each budget with what actually happened.", { to: "/budgets" }),
  R("account-type-summary", "Account Type Summary", "Accountant", "range", "Debits and credits per account type."),
  R("general-ledger", "General Ledger", "Accountant", "range", "Opening, debits, credits and closing for every account."),
  R("detailed-general-ledger", "Detailed General Ledger", "Accountant", "range", "Every transaction in every account with a running balance."),
  R("journal-report", "Journal Report", "Accountant", "range", "Each transaction as a debit/credit journal entry."),
  R("day-book", "Day Book", "Accountant", "range", "All transactions day by day."),
  R("trial-balance", "Trial Balance", "Accountant", "asof", "Debit and credit totals of every account."),
];
const CATEGORIES = [...new Set(REPORTS.map((r) => r.group))];

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};
const FAV = "mgi.reportFavs";
const SEEN = "mgi.reportSeen";
const reportHref = (r) => (r.mode === "link" ? r.to : `/reports/${r.key}`);

export function ReportsHome() {
  const [view, setView] = useState("home");
  const [q, setQ] = useState("");
  const [favs, setFavs] = useState(() => store.get(FAV, []));
  const seen = store.get(SEEN, {});
  const toggleFav = (k) => {
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
    setFavs(next);
    store.set(FAV, next);
  };
  let list = REPORTS;
  if (view === "favorites") list = list.filter((r) => favs.includes(r.key));
  else if (view === "recent") list = list.filter((r) => seen[r.key]).sort((a, b) => seen[b.key] - seen[a.key]);
  else if (view !== "home") list = list.filter((r) => r.group === view);
  if (q.trim()) {
    const t = q.trim().toLowerCase();
    list = REPORTS.filter((r) => `${r.title} ${r.group} ${r.desc}`.toLowerCase().includes(t));
  }
  const title = q.trim() ? `Search results` : view === "home" ? "All Reports" : view === "favorites" ? "Favorites" : view === "recent" ? "Recently Visited" : view;
  const side = (k, label, count) => (
    <button key={k} className={`rc-side-item ${view === k && !q ? "active" : ""}`} onClick={() => (setView(k), setQ(""))}>
      <span>{label}</span>
      {count !== undefined && <span className="rc-count">{count}</span>}
    </button>
  );
  return (
    <>
      <PageHeader title="Reports Center" subtitle="Every report is built live from your invoices, bills, payments, expenses, journals and bank statements.">
        <input className="input rc-search" placeholder="Search reports" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageHeader>
      <div className="rc">
        <aside className="rc-side card">
          {side("home", "Home", REPORTS.length)}
          {side("favorites", "Favorites", favs.length)}
          {side("recent", "Recently Visited")}
          <div className="rc-side-label">Report Category</div>
          {CATEGORIES.map((c) => side(c, c, REPORTS.filter((r) => r.group === c).length))}
        </aside>
        <div className="card rc-main">
          <div className="rc-main-head">
            <h3>{title}</h3>
            <span className="muted small">{list.length} reports</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Report Name</th>
                <th>Report Category</th>
                <th>Created By</th>
                <th>Last Visited</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.key}>
                  <td>
                    <button className={`rc-star ${favs.includes(r.key) ? "on" : ""}`} title={favs.includes(r.key) ? "Remove from favorites" : "Add to favorites"} onClick={() => toggleFav(r.key)}>
                      {favs.includes(r.key) ? "★" : "☆"}
                    </button>
                    <Link to={reportHref(r)} className="rc-name">
                      {r.title}
                    </Link>
                    <div className="muted small rc-desc">{r.desc}</div>
                  </td>
                  <td>{r.group}</td>
                  <td className="muted">System Generated</td>
                  <td className="muted">{seen[r.key] ? new Date(seen[r.key]).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={4} className="muted center">
                    {view === "favorites" ? "Star a report to add it here." : "No reports found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
    if (meta) store.set(SEEN, { ...store.get(SEEN, {}), [key]: Date.now() });
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
  const Body = BODIES[key] || GenericReport;

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

/* ---------------- Generic renderers (Reports Center catalog) ---------------- */
const isNum = (t) => t === "money" || t === "number";
function Cell({ c, r }) {
  const v = r[c.key];
  if (v === null || v === undefined || v === "") return <td className={isNum(c.type) ? "num" : ""} />;
  let content = v;
  if (c.type === "money") content = money(v);
  else if (c.type === "number") content = Number(v).toLocaleString("en-IN");
  else if (c.type === "date") content = date(v);
  else if (c.type === "status") content = <Status value={v} />;
  else if (c.type === "doc" && r.ref) content = <Link to={docLink(r.ref.type, r.ref.id)}>{v}</Link>;
  if (c.link && r[c.link]) content = <Link to={r[c.link]}>{content}</Link>;
  return <td className={isNum(c.type) || c.align === "right" ? "num" : ""}>{content}</td>;
}
const sumCol = (rows, c) => Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 100) / 100;
function TotalsRow({ columns, rows, label, cls }) {
  if (!columns.some((c) => c.sum)) return null;
  return (
    <tr className={cls}>
      {columns.map((c, i) => (
        <td key={c.key} className={isNum(c.type) ? "num" : ""}>
          {c.sum ? (c.type === "money" ? money(sumCol(rows, c)) : sumCol(rows, c).toLocaleString("en-IN")) : i === 0 ? label : ""}
        </td>
      ))}
    </tr>
  );
}
function TableReport({ d }) {
  const { columns, rows, groupBy } = d;
  if (!rows.length) return <p className="muted center">No transactions for this period.</p>;
  const groups = groupBy ? [...new Set(rows.map((r) => r[groupBy]))] : [null];
  return (
    <table className="report-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={isNum(c.type) || c.align === "right" ? "num" : ""}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const mine = g === null ? rows : rows.filter((r) => r[groupBy] === g);
          return [
            g !== null && (
              <tr className="row-section" key={`h-${g}`}>
                <td colSpan={columns.length}>{g}</td>
              </tr>
            ),
            ...mine.map((r, i) => (
              <tr key={`${g}-${i}`} className={r.muted ? "muted" : ""}>
                {columns.map((c) => (
                  <Cell key={c.key} c={c} r={r} />
                ))}
              </tr>
            )),
            g !== null && groups.length > 1 && <TotalsRow key={`t-${g}`} columns={columns} rows={mine} label={`Total for ${g}`} cls="row-subtotal" />,
          ];
        })}
        <TotalsRow columns={columns} rows={rows} label="Total" cls="row-grand" />
      </tbody>
    </table>
  );
}
function StatementLines({ lines, range }) {
  return lines.map((l, i) => {
    const link = acctLink(l.code, range);
    const label = link ? <Link to={link}>{l.label}</Link> : l.label;
    if (l.style === "head")
      return (
        <tr className="row-head" key={i}>
          <td colSpan={2}>{l.label}</td>
        </tr>
      );
    if (l.style === "section")
      return (
        <tr className="row-section" key={i}>
          <td colSpan={2}>{l.label}</td>
        </tr>
      );
    const cls = { subtotal: "row-subtotal", total: "row-total", grand: "row-grand" }[l.style] || "";
    return (
      <tr className={cls} key={i}>
        <td style={l.style === "item" ? { paddingLeft: 12 + (l.indent || 0) * 18 } : undefined}>{label}</td>
        <td className="num">{l.amount === undefined || l.amount === null ? "" : money(l.amount)}</td>
      </tr>
    );
  });
}
function StatementReport({ d, range }) {
  return (
    <>
      <table className="report-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          <StatementLines lines={d.lines} range={range} />
        </tbody>
      </table>
      {d.check === false && <div className="alert alert-error">The cash flow does not tie to your cash and bank balances — please report this.</div>}
      {d.note && <p className="muted small report-note">{d.note}</p>}
    </>
  );
}
function HorizontalReport({ d, range }) {
  const side = (s) => (
    <table className="report-table">
      <thead>
        <tr>
          <th>{s.title}</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        <StatementLines lines={s.lines} range={range} />
      </tbody>
      <tfoot>
        <tr className="row-grand">
          <td>Total</td>
          <td className="num">{money(s.total)}</td>
        </tr>
      </tfoot>
    </table>
  );
  return (
    <div className="report-horizontal">
      {side(d.left)}
      {side(d.right)}
    </div>
  );
}
function GenericReport(p) {
  if (p.d.kind === "statement") return <StatementReport {...p} />;
  if (p.d.kind === "horizontal") return <HorizontalReport {...p} />;
  return (
    <>
      <TableReport {...p} />
      {p.d.note && <p className="muted small report-note">{p.d.note}</p>}
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
