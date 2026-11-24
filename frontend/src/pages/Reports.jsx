import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import SearchSelect from "../components/SearchSelect";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { stateName } from "../lib/constants";
import { PERIODS, periodRange, fmtRange, exportCsv } from "../lib/period";
import { PageHeader, Spinner, Status, Modal } from "../components/ui";
import { docLink } from "./Accounts";
import { useLocations } from "../lib/locations";
import Icon from "../components/Icon";

/* ---------------- Period pickers ---------------- */
// Tally's Alt+F2 (change period): TallyKeys fires "tally:period"; the picker on the page opens this box.
function usePeriodKey() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener("tally:period", h);
    return () => window.removeEventListener("tally:period", h);
  }, []);
  return [open, setOpen];
}
function ChangePeriod({ from, to, single, onApply, onClose }) {
  const [f, setF] = useState({ from: from || "", to: to || "" });
  const toRef = useRef(null);
  const apply = () => {
    if (!f.from || !f.to || f.from > f.to) return;
    onApply(f);
  };
  const keys = (next) => (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (next) next.current?.focus();
      else apply();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      apply();
    }
  };
  return (
    <Modal
      open
      title="Change Period (Alt+F2)"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div className="row-2">
        <label className="field">
          <span className="field-label">From</span>
          <input
            type="date"
            autoFocus
            value={f.from}
            onChange={(e) => setF({ ...f, from: e.target.value })}
            onKeyDown={keys(toRef)}
          />
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input
            ref={toRef}
            type="date"
            value={f.to}
            onChange={(e) => setF({ ...f, to: e.target.value })}
            onKeyDown={keys(null)}
          />
        </label>
      </div>
      {f.from && f.to && f.from > f.to && (
        <p className="text-red small">From must be on or before To</p>
      )}
      {single && (
        <p className="muted small">
          Balances as at the To date; income and profit for From–To, as in
          Tally.
        </p>
      )}
    </Modal>
  );
}

export function PeriodPicker({ value, onChange }) {
  const [changing, setChanging] = usePeriodKey();
  return (
    <div className="period" data-period>
      {changing && (
        <ChangePeriod
          from={value.from}
          to={value.to}
          onClose={() => setChanging(false)}
          onApply={(r) => {
            setChanging(false);
            const preset = PERIODS.find(
              ([k]) =>
                k !== "custom" &&
                periodRange(k).from === r.from &&
                periodRange(k).to === r.to,
            );
            onChange(
              preset
                ? { key: preset[0], from: r.from, to: r.to }
                : { key: "custom", from: r.from, to: r.to },
            );
          }}
        />
      )}
      <select
        className="select-inline"
        value={value.key}
        onChange={(e) => {
          const key = e.target.value;
          onChange(
            key === "custom" ? { ...value, key } : { key, ...periodRange(key) },
          );
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
          <input
            type="date"
            value={value.from}
            max={value.to}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
          />
          <span className="muted">to</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
          />
        </>
      )}
    </div>
  );
}

// 1 April of the financial year a date falls in.
const fyStart = (d) => {
  const x = d ? new Date(d) : new Date();
  const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1;
  return `${y}-04-01`;
};

function AsOfPicker({ value, from, onChange }) {
  const [changing, setChanging] = usePeriodKey();
  return (
    <div className="period" data-period>
      {changing && (
        <ChangePeriod
          single
          from={from || fyStart(value)}
          to={value}
          onClose={() => setChanging(false)}
          onApply={(r) => {
            setChanging(false);
            onChange(r.to, r.from);
          }}
        />
      )}
      <span className="muted small">As of</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ---------------- Catalogue ---------------- */
const R = (key, title, group, mode, desc, extra = {}) => ({
  key,
  title,
  group,
  mode,
  desc,
  ...extra,
});
export const REPORTS = [
  // Business Overview
  R(
    "profit-and-loss",
    "Profit and Loss",
    "Business Overview",
    "range",
    "Income, cost of goods sold and expenses, and the profit left over.",
  ),
  R(
    "pl-schedule-iii",
    "Profit and Loss (Schedule III)",
    "Business Overview",
    "range",
    "Statement of profit and loss in the Companies Act format.",
  ),
  R(
    "horizontal-pl",
    "Profit & Loss A/c (Tally horizontal)",
    "Business Overview",
    "range",
    "As in Tally: Trading and P&L account side by side, Tally groups with their ledgers, Opening and Closing Stock.",
  ),
  R(
    "cash-flow",
    "Cash Flow Statement",
    "Business Overview",
    "range",
    "Where cash came from and went: operating, investing, financing.",
  ),
  R(
    "balance-sheet",
    "Balance Sheet",
    "Business Overview",
    "asof",
    "What the business owns and owes on a given date.",
  ),
  R(
    "horizontal-bs",
    "Balance Sheet (Tally horizontal)",
    "Business Overview",
    "asof",
    "As in Tally: Liabilities and Assets side by side, Tally groups (Capital, Current Liabilities, Sundry Debtors…) with their ledgers.",
  ),
  R(
    "bs-schedule-iii",
    "Balance Sheet (Schedule III)",
    "Business Overview",
    "asof",
    "Balance sheet in the Companies Act format.",
  ),
  R(
    "ratios",
    "Business Performance Ratios",
    "Business Overview",
    "range",
    "Liquidity, profitability, solvency and efficiency ratios.",
  ),
  R(
    "movement-of-equity",
    "Movement of Equity",
    "Business Overview",
    "range",
    "Opening, additions, reductions and closing equity.",
  ),
  // Sales
  R(
    "sales-by-customer",
    "Sales by Customer",
    "Sales",
    "range",
    "Invoiced sales for each customer.",
  ),
  R(
    "sales-by-item",
    "Sales by Item",
    "Sales",
    "range",
    "Quantity sold and sales value per item.",
  ),
  R(
    "sales-summary",
    "Sales Summary",
    "Sales",
    "range",
    "Sales, tax and credit notes month by month.",
  ),
  // Receivables
  R(
    "customer-balances",
    "Customer Balances",
    "Receivables",
    "none",
    "Invoiced, received, credits and balance due per customer.",
  ),
  R(
    "ar-aging",
    "AR Aging Summary",
    "Receivables",
    "none",
    "What customers owe, by how overdue it is.",
  ),
  R(
    "ar-aging-details",
    "AR Aging Details",
    "Receivables",
    "none",
    "Every unpaid invoice with its age.",
  ),
  R(
    "invoice-details",
    "Invoice Details",
    "Receivables",
    "range",
    "All invoices in the period with status and balance.",
  ),
  R(
    "quote-details",
    "Quote Details",
    "Receivables",
    "range",
    "All quotes in the period.",
  ),
  R(
    "sales-order-details",
    "Sales Order Details",
    "Receivables",
    "range",
    "All sales orders in the period.",
  ),
  R(
    "credit-note-details",
    "Credit Note Details",
    "Receivables",
    "range",
    "All credit notes and their remaining credit.",
  ),
  // Payments Received
  R(
    "payments-received",
    "Payments Received",
    "Payments Received",
    "range",
    "Customer payments with mode, reference and invoices settled.",
  ),
  // Payables
  R(
    "vendor-balances",
    "Vendor Balances",
    "Payables",
    "none",
    "Billed, paid, credits and balance due per vendor.",
  ),
  R(
    "ap-aging",
    "AP Aging Summary",
    "Payables",
    "none",
    "What you owe vendors, by how overdue it is.",
  ),
  R(
    "ap-aging-details",
    "AP Aging Details",
    "Payables",
    "none",
    "Every unpaid bill with its age.",
  ),
  R(
    "bills-180-days",
    "Bills Unpaid over 180 Days (GST)",
    "Payables",
    "none",
    "Purchase bills not paid within 180 days of the bill date (ITC reversal, Rule 37), and those reaching it.",
  ),
  R(
    "bill-details",
    "Bill Details",
    "Payables",
    "range",
    "All bills in the period with status and balance.",
  ),
  R(
    "purchase-order-details",
    "Purchase Order Details",
    "Payables",
    "range",
    "All purchase orders in the period.",
  ),
  R(
    "vendor-credit-details",
    "Vendor Credit Details",
    "Payables",
    "range",
    "All vendor credits and their remaining credit.",
  ),
  R(
    "payments-made",
    "Payments Made",
    "Payables",
    "range",
    "Vendor payments with mode, reference and bills settled.",
  ),
  // Purchases and Expenses
  R(
    "purchases-by-vendor",
    "Purchases by Vendor",
    "Purchases and Expenses",
    "range",
    "Billed purchases for each vendor.",
  ),
  R(
    "purchases-by-item",
    "Purchases by Item",
    "Purchases and Expenses",
    "range",
    "Quantity bought and cost per item.",
  ),
  R(
    "expenses-by-category",
    "Expenses by Category",
    "Purchases and Expenses",
    "range",
    "Spending per expense account, including bills.",
  ),
  R(
    "expenses-by-vendor",
    "Expenses by Vendor",
    "Purchases and Expenses",
    "range",
    "Bills and expenses grouped by vendor.",
  ),
  R(
    "expense-details",
    "Expense Details",
    "Purchases and Expenses",
    "range",
    "Every recorded expense with GST.",
  ),
  // Taxes
  R(
    "gstr1",
    "GSTR-1 Summary",
    "Taxes",
    "range",
    "Outward supplies: B2B, B2C large & small, credit notes, HSN summary.",
    { period: "last_month" },
  ),
  R(
    "gstr3b",
    "GSTR-3B Summary",
    "Taxes",
    "range",
    "Tax on sales, input tax credit and net GST payable.",
    { period: "last_month" },
  ),
  R(
    "tax-summary",
    "Tax Summary",
    "Taxes",
    "range",
    "Output and input GST by tax rate.",
  ),
  // Inventory
  R(
    "inventory-summary",
    "Inventory Summary",
    "Inventory",
    "range",
    "Opening, in, out, on hand, committed and available stock per item.",
  ),
  R(
    "stock-summary",
    "Stock Summary (Tally)",
    "Inventory",
    "range",
    "Opening, inward, outward and closing stock per item, in quantity and value — what Opening / Closing Stock in the P&L opens to.",
  ),
  R(
    "inventory-valuation",
    "Inventory Valuation Summary",
    "Inventory",
    "asof",
    "Stock on hand and its FIFO value on a date.",
  ),
  R(
    "fifo-cost-lots",
    "FIFO Cost Lot Tracking",
    "Inventory",
    "asof",
    "Each lot of stock still on hand, with its cost.",
  ),
  R(
    "stock-movement",
    "Stock Movement",
    "Inventory",
    "range",
    "Every stock in and out, item by item.",
  ),
  R(
    "product-sales",
    "Product Sales Report",
    "Inventory",
    "range",
    "Quantity sold, sales, cost and margin per item.",
  ),
  R(
    "warehouse-stock",
    "Warehouse Stock Summary",
    "Inventory",
    "asof",
    "Stock on hand in each warehouse.",
  ),
  R(
    "committed-stock",
    "Committed Stock Details",
    "Inventory",
    "none",
    "Stock promised on confirmed sales orders.",
  ),
  R(
    "reorder-report",
    "Reorder Report",
    "Inventory",
    "none",
    "Items at or below their reorder level.",
  ),
  // Projects and Timesheet
  R(
    "project-summary",
    "Project Summary",
    "Projects and Timesheet",
    "none",
    "Budget vs logged hours, billed and unbilled per project.",
  ),
  R(
    "timesheet-details",
    "Timesheet Details",
    "Projects and Timesheet",
    "range",
    "Every time entry with its status and billable amount.",
  ),
  R(
    "unbilled-time",
    "Unbilled Time",
    "Projects and Timesheet",
    "none",
    "Billable time not yet invoiced, by customer.",
  ),
  // Recurring
  R(
    "recurring-profiles",
    "Recurring Profiles",
    "Recurring",
    "none",
    "Recurring invoices, bills and expenses with their schedules.",
  ),
  // Activity
  R(
    "email-log",
    "Emails Sent",
    "Activity",
    "range",
    "Documents and reminders emailed from OrdexaGo.",
  ),
  // Fixed Assets
  R(
    "fixed-asset-register",
    "Fixed Asset Register",
    "Fixed Assets",
    "asof",
    "Every asset with cost, accumulated depreciation and book value.",
  ),
  R(
    "depreciation-schedule",
    "Depreciation Schedule",
    "Fixed Assets",
    "range",
    "Opening value, additions, depreciation, disposals and closing value per asset.",
  ),
  // Banking
  R(
    "reconciliation-status",
    "Reconciliation Status",
    "Banking",
    "none",
    "Books vs bank balance and lines still to match, per account.",
  ),
  // Accountant
  R(
    "account-transactions",
    "Account Transactions",
    "Accountant",
    "link",
    "Pick an account to see every entry with a running balance.",
    { to: "/chart-of-accounts" },
  ),
  R(
    "budget-vs-actuals",
    "Budget vs Actuals",
    "Accountant",
    "link",
    "Compare each budget with what actually happened.",
    { to: "/budgets" },
  ),
  R(
    "account-type-summary",
    "Account Type Summary",
    "Accountant",
    "range",
    "Debits and credits per account type.",
  ),
  R(
    "general-ledger",
    "General Ledger",
    "Accountant",
    "range",
    "Opening, debits, credits and closing for every account.",
  ),
  R(
    "detailed-general-ledger",
    "Detailed General Ledger",
    "Accountant",
    "range",
    "Every transaction in every account with a running balance.",
  ),
  R(
    "journal-report",
    "Journal Report",
    "Accountant",
    "range",
    "Each transaction as a debit/credit journal entry.",
  ),
  R(
    "party-ledger",
    "Party Ledger",
    "Accountant",
    "range",
    "A customer's or vendor's account: opening balance, every voucher with running balance, closing — print or download.",
  ),
  R(
    "day-book",
    "Day Book",
    "Accountant",
    "range",
    "All transactions day by day.",
  ),
  R(
    "trial-balance",
    "Trial Balance",
    "Accountant",
    "asof",
    "Debit and credit totals of every account.",
  ),
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
  else if (view === "recent")
    list = list
      .filter((r) => seen[r.key])
      .sort((a, b) => seen[b.key] - seen[a.key]);
  else if (view !== "home") list = list.filter((r) => r.group === view);
  if (q.trim()) {
    const t = q.trim().toLowerCase();
    list = REPORTS.filter((r) =>
      `${r.title} ${r.group} ${r.desc}`.toLowerCase().includes(t),
    );
  }
  const title = q.trim()
    ? `Search results`
    : view === "home"
      ? "All Reports"
      : view === "favorites"
        ? "Favorites"
        : view === "recent"
          ? "Recently Visited"
          : view;
  const side = (k, label, count) => (
    <button
      key={k}
      className={`rc-side-item ${view === k && !q ? "active" : ""}`}
      onClick={() => (setView(k), setQ(""))}
    >
      <span>{label}</span>
      {count !== undefined && <span className="rc-count">{count}</span>}
    </button>
  );
  return (
    <>
      <PageHeader
        title="Reports Center"
        subtitle="Every report is built live from your invoices, bills, payments, expenses, journals and bank statements."
      >
        <input
          className="input rc-search"
          placeholder="Search reports"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </PageHeader>
      <div className="rc">
        <aside className="rc-side card">
          {side("home", "Home", REPORTS.length)}
          {side("favorites", "Favorites", favs.length)}
          {side("recent", "Recently Visited")}
          <div className="rc-side-label">Report Category</div>
          {CATEGORIES.map((c) =>
            side(c, c, REPORTS.filter((r) => r.group === c).length),
          )}
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
                    <button
                      className={`rc-star ${favs.includes(r.key) ? "on" : ""}`}
                      title={
                        favs.includes(r.key)
                          ? "Remove from favorites"
                          : "Add to favorites"
                      }
                      onClick={() => toggleFav(r.key)}
                    >
                      {favs.includes(r.key) ? "★" : "☆"}
                    </button>
                    <Link to={reportHref(r)} className="rc-name">
                      {r.title}
                    </Link>
                    <div className="muted small rc-desc">{r.desc}</div>
                  </td>
                  <td>{r.group}</td>
                  <td className="muted">System Generated</td>
                  <td className="muted">
                    {seen[r.key]
                      ? new Date(seen[r.key]).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={4} className="muted center">
                    {view === "favorites"
                      ? "Star a report to add it here."
                      : "No reports found."}
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
  const nav = useNavigate();
  // P&L / Balance Sheet: vertical or Tally's horizontal layout (remembered on this device).
  const LAYOUT = {
    "profit-and-loss": "horizontal-pl",
    "horizontal-pl": "profit-and-loss",
    "balance-sheet": "horizontal-bs",
    "horizontal-bs": "balance-sheet",
  };
  const horizontal = key === "horizontal-pl" || key === "horizontal-bs";
  const switchLayout = (h) => {
    try {
      localStorage.setItem("statementLayout", h ? "horizontal" : "vertical");
    } catch {}
    if (h !== horizontal) nav(`/reports/${LAYOUT[key]}`, { replace: true });
  };
  const { organization } = useAuth();
  // A link can carry its period (?from=…&to=…), e.g. Closing Stock in the P&L opening the Stock Summary.
  const urlRange = () => {
    const q = new URLSearchParams(window.location.search);
    const f = q.get("from");
    const t = q.get("to");
    return /^\d{4}-\d{2}-\d{2}$/.test(f || "") &&
      /^\d{4}-\d{2}-\d{2}$/.test(t || "")
      ? { key: "custom", from: f, to: t }
      : null;
  };
  const [range, setRange] = useState(
    () =>
      urlRange() || {
        key: meta?.period || "this_fy",
        ...periodRange(meta?.period || "this_fy"),
      },
  );
  const [asOf, setAsOf] = useState(isoDate());
  const [stockEdit, setStockEdit] = useState(false);
  const [reloadN, setReloadN] = useState(0);
  const STOCK_REPORTS = [
    "profit-and-loss",
    "horizontal-pl",
    "balance-sheet",
    "horizontal-bs",
    "trial-balance",
  ];
  const [asOfFrom, setAsOfFrom] = useState(""); // Alt+F2 period on as-at reports (Balance Sheet, Trial Balance)
  const periodOk =
    ["balance-sheet", "trial-balance"].includes(key) &&
    asOfFrom &&
    asOfFrom <= asOf;
  const { branches } = useLocations();
  const [branch, setBranch] = useState("");
  const [loaded, setData] = useState(null);
  // Only the data of the report on screen: switching report (e.g. Vertical → Horizontal) renders before the new
  // data comes, and the other report's data would break the new layout (blank page).
  const data = loaded && loaded._key === key ? loaded : null;
  const [error, setError] = useState("");
  const paper = useRef(null);
  // Party Ledger: the customer / vendor, kept in the URL (?party=customer:<id>).
  const [sp, setSp] = useSearchParams();
  const party = key === "party-ledger" ? sp.get("party") || "" : "";
  const [partyOpts, setPartyOpts] = useState([]);
  useEffect(() => {
    if (key !== "party-ledger") return;
    Promise.all([api.get("/customers"), api.get("/vendors")])
      .then(([c, v]) =>
        setPartyOpts([
          ...c.data.map((x) => ({
            value: `customer:${x._id}`,
            label: x.displayName,
            sub: `Customer${x.gstin ? ` · ${x.gstin}` : ""}`,
            search: `${x.companyName || ""} ${x.phone || ""}`,
          })),
          ...v.data.map((x) => ({
            value: `vendor:${x._id}`,
            label: x.displayName,
            sub: `Vendor${x.gstin ? ` · ${x.gstin}` : ""}`,
            search: `${x.companyName || ""} ${x.phone || ""}`,
          })),
        ]),
      )
      .catch(() => {});
  }, [key]);
  // Live / Tally view of the Trial Balance, P&L and Balance Sheet (remembered on this device).
  const hasView = [
    "trial-balance",
    "profit-and-loss",
    "balance-sheet",
  ].includes(key);
  const [view, setViewState] = useState(() => {
    try {
      return localStorage.getItem("reportView") === "tally" ? "tally" : "live";
    } catch {
      return "live";
    }
  });
  const setView = (v) => {
    setViewState(v);
    try {
      localStorage.setItem("reportView", v);
    } catch {}
  };
  // Trial Balance: condensed (ledger-wise) or detailed (each ledger's transactions), Alt+F5 as in Tally.
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    if (key !== "trial-balance") return;
    const t = () => setDetail((x) => !x);
    window.addEventListener("tally:detail", t);
    return () => window.removeEventListener("tally:detail", t);
  }, [key]);

  useEffect(() => {
    setRange(
      urlRange() || {
        key: meta?.period || "this_fy",
        ...periodRange(meta?.period || "this_fy"),
      },
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (meta) store.set(SEEN, { ...store.get(SEEN, {}), [key]: Date.now() });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!meta) return;
    setData(null);
    setError("");
    const params =
      meta.mode === "range"
        ? { from: range.from, to: range.to }
        : meta.mode === "asof"
          ? { to: asOf, ...(periodOk ? { from: asOfFrom } : {}) }
          : {};
    if (branch) params.branch = branch;
    if (hasView && view === "tally") params.view = "tally";
    if (key === "trial-balance" && detail) params.detail = "1";
    if (key === "party-ledger") {
      if (!party)
        return setData({
          kind: "party-ledger",
          party: null,
          rows: [],
          _key: key,
        });
      params.party = party;
    }
    api
      .get(`/reports/${key}`, { params })
      .then((r) => setData({ ...r.data, _key: key }))
      .catch((e) => setError(errMsg(e)));
  }, [
    key,
    meta,
    range.from,
    range.to,
    asOf,
    asOfFrom,
    branch,
    view,
    hasView,
    detail,
    party,
    reloadN,
  ]);

  if (!meta) return <p>Report not found.</p>;
  const subtitle =
    meta.mode === "range"
      ? fmtRange(range.from, range.to)
      : meta.mode === "asof"
        ? periodOk
          ? `${fmtRange(asOfFrom, asOf)}${key === "balance-sheet" ? ` · as at ${date(asOf)}` : ""}`
          : `As of ${date(asOf)}`
        : `As of ${date(new Date())}`;
  const Body = BODIES[key] || GenericReport;

  return (
    <>
      {stockEdit && (
        <StockValues
          onClose={() => setStockEdit(false)}
          onSaved={() => (setStockEdit(false), setReloadN((n) => n + 1))}
        />
      )}
      <PageHeader title={meta.title} back="/reports">
        {STOCK_REPORTS.includes(key) && (
          <button
            className="btn"
            onClick={() => setStockEdit(true)}
            title="Opening stock as per books, closing stock entered by hand (as in Tally)"
          >
            Stock values
          </button>
        )}
        {LAYOUT[key] && (
          <div
            className="seg"
            role="group"
            aria-label="Layout"
            title="Horizontal: as Tally shows it, groups on two sides"
          >
            <button
              type="button"
              className={!horizontal ? "on" : ""}
              onClick={() => switchLayout(false)}
            >
              Vertical
            </button>
            <button
              type="button"
              className={horizontal ? "on" : ""}
              onClick={() => switchLayout(true)}
            >
              Horizontal (Tally)
            </button>
          </div>
        )}
        {hasView && (
          <div
            className="seg"
            role="group"
            aria-label="Report view"
            title="Live: stock in Inventory Asset and Cost of Goods Sold. Tally: purchases in full, Opening and Closing Stock, as in Tally."
          >
            {[
              ["live", "Live"],
              ["tally", "Tally"],
            ].map(([v, l]) => (
              <button
                key={v}
                type="button"
                className={view === v ? "on" : ""}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {l}
              </button>
            ))}
          </div>
        )}
        {key === "trial-balance" && (
          <div
            className="seg"
            role="group"
            aria-label="Trial balance detail"
            data-views
            title="Condensed: one line per ledger. Detailed: each ledger's transactions (Alt+F5)."
          >
            <button
              type="button"
              className={!detail ? "on" : ""}
              aria-pressed={!detail}
              onClick={() => setDetail(false)}
            >
              Condensed
            </button>
            <button
              type="button"
              className={detail ? "on" : ""}
              aria-pressed={detail}
              onClick={() => setDetail(true)}
            >
              Detailed
            </button>
          </div>
        )}
        {key === "party-ledger" && (
          <div style={{ minWidth: 260 }}>
            <SearchSelect
              value={party}
              options={partyOpts}
              placeholder="Choose a customer or vendor…"
              onChange={(v) => setSp(v ? { party: v } : {}, { replace: true })}
            />
          </div>
        )}
        {meta.mode === "range" && (
          <PeriodPicker value={range} onChange={setRange} />
        )}
        {meta.mode === "asof" && (
          <AsOfPicker
            value={asOf}
            from={asOfFrom}
            onChange={(to, from) => {
              setAsOf(to);
              setAsOfFrom(from === undefined ? "" : from);
            }}
          />
        )}
        {branches.length > 0 && (
          <select
            className="select-inline"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            title="Branch"
          >
            <option value="">All Branches</option>
            <option value="head">Head Office</option>
            {branches.map((b) => (
              <option key={b._id} value={b._id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn"
          onClick={() =>
            paper.current &&
            exportCsv(
              paper.current,
              `${key === "party-ledger" && data?.party ? `Ledger ${data.party.name}` : meta.title} ${subtitle}`,
            )
          }
        >
          {key === "party-ledger" ? "Download (Excel / CSV)" : "Export CSV"}
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
            <h2>
              {key === "party-ledger" && data.party
                ? `${data.party.name} — Ledger Account`
                : meta.title}
            </h2>
            <div className="muted small">
              {subtitle}
              {branch &&
                ` · ${branch === "head" ? "Head Office" : branches.find((b) => b._id === branch)?.name}`}
              {hasView && data.view === "tally" && " · Tally view"}
            </div>
          </div>
          <Body
            d={data}
            range={
              meta.mode === "range" ? range : { from: "2000-01-01", to: asOf }
            }
          />
        </div>
      )}
    </>
  );
}

/* ---------------- Report bodies ---------------- */
const acctLink = (code, range) =>
  code && !code.startsWith("_")
    ? `/chart-of-accounts/${encodeURIComponent(code)}?from=${range.from}&to=${range.to}`
    : null;

function Section({ title, sec, range, totalLabel }) {
  return (
    <>
      <tr className="row-section">
        <td colSpan={2}>{title}</td>
      </tr>
      {sec.rows.map((r) => (
        <tr key={r.code}>
          <td className="indent">
            {acctLink(r.code, range) ? (
              <Link to={acctLink(r.code, range)}>{r.name}</Link>
            ) : (
              r.name
            )}
          </td>
          <td className="num">{money(r.amount, r.currency)}</td>
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
        <Section
          title="Operating Income"
          sec={d.operatingIncome}
          range={range}
        />
        <Section
          title={
            d.view === "tally"
              ? "Cost of Goods Sold (Opening Stock + Purchases − Closing Stock)"
              : "Cost of Goods Sold"
          }
          sec={d.cogs}
          range={range}
          totalLabel={
            d.view === "tally" ? "Total Cost of Goods Sold" : undefined
          }
        />
        <tr className="row-total">
          <td>Gross Profit</td>
          <td className="num">{money(d.grossProfit)}</td>
        </tr>
        <Section
          title="Operating Expense"
          sec={d.operatingExpense}
          range={range}
        />
        <tr className="row-total">
          <td>Operating Profit</td>
          <td className="num">{money(d.operatingProfit)}</td>
        </tr>
        <Section
          title="Non Operating Income"
          sec={d.otherIncome}
          range={range}
        />
        <Section
          title="Non Operating Expense"
          sec={d.otherExpense}
          range={range}
        />
        <tr className="row-grand">
          <td>Net Profit / Loss</td>
          <td
            className={`num ${d.netProfit < 0 ? "text-overdue" : "text-paid"}`}
          >
            {money(d.netProfit)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function BalanceSheet({ d, range }) {
  return (
    <>
      {!d.balanced && (
        <div className="alert alert-error">
          Assets and liabilities + equity don't match. Please tell us — this
          shouldn't happen.
        </div>
      )}
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
          <Section
            title="Current Liabilities"
            sec={d.currentLiabilities}
            range={range}
          />
          <Section
            title="Long Term Liabilities"
            sec={d.longTermLiabilities}
            range={range}
          />
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
  // Ledgers grouped as in Tally (by account group), with group totals; detailed adds each ledger's transactions.
  const groups = [];
  for (const r of d.rows) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, rows: [], debit: 0, credit: 0 }));
    g.rows.push(r);
    g.debit += r.debit;
    g.credit += r.credit;
  }
  const net = (g) => {
    const n = Math.round((g.debit - g.credit) * 100) / 100;
    return { debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 };
  };
  const amt = (n) => (n ? money(n) : "");
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Particulars</th>
          {d.detail && <th>Number</th>}
          <th className="num">Debit</th>
          <th className="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {d.detail && (
          <tr>
            <td colSpan={4} className="muted small">
              Transactions from {date(d.detailFrom)} to {date(d.to)}, after each
              ledger's opening balance.
            </td>
          </tr>
        )}
        {groups.map((g) => {
          const gn = net(g);
          return [
            <tr key={`g-${g.name}`} className="row-section">
              <td colSpan={d.detail ? 2 : 1}>
                <strong>{g.name}</strong>
              </td>
              <td className="num">
                <strong>{amt(gn.debit)}</strong>
              </td>
              <td className="num">
                <strong>{amt(gn.credit)}</strong>
              </td>
            </tr>,
            ...g.rows.flatMap((r) => [
              <tr key={r.code} className={d.detail ? "row-sub" : ""}>
                <td style={{ paddingLeft: 24 }}>
                  {r.code.startsWith("_") ? (
                    r.name
                  ) : (
                    <Link to={acctLink(r.code, range)}>{r.name}</Link>
                  )}
                </td>
                {d.detail && <td />}
                <td className="num">{amt(r.debit)}</td>
                <td className="num">{amt(r.credit)}</td>
              </tr>,
              // Accounts Receivable / Payable: one line per customer / vendor (Tally's Sundry Debtors / Creditors).
              ...(r.parties || []).flatMap((p) => [
                <tr
                  key={`${r.code}-p-${p.id || "other"}`}
                  className={d.detail ? "row-sub" : ""}
                >
                  <td style={{ paddingLeft: 48 }}>
                    {p.id ? (
                      <Link
                        to={`/${p.kind === "vendor" ? "vendors" : "customers"}/${p.id}`}
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <span className="muted">{p.name}</span>
                    )}
                  </td>
                  {d.detail && <td />}
                  <td className="num">{amt(p.debit)}</td>
                  <td className="num">{amt(p.credit)}</td>
                </tr>,
                ...(d.detail
                  ? [
                      ...(p.opening
                        ? [
                            <tr
                              key={`${r.code}-p-${p.id || "other"}-ob`}
                              className="row-muted small"
                            >
                              <td style={{ paddingLeft: 72 }}>
                                Opening balance
                              </td>
                              <td />
                              <td className="num">
                                {p.opening > 0 ? money(p.opening) : ""}
                              </td>
                              <td className="num">
                                {p.opening < 0 ? money(-p.opening) : ""}
                              </td>
                            </tr>,
                          ]
                        : []),
                      ...(p.txns || []).map((t, i) => (
                        <tr
                          key={`${r.code}-p-${p.id || "other"}-${i}`}
                          className="small"
                        >
                          <td style={{ paddingLeft: 72 }}>
                            <span className="muted">{date(t.date)}</span> ·{" "}
                            {t.type}
                          </td>
                          <td>
                            {t.id ? (
                              <Link to={docLink(t.type, t.id)}>{t.number}</Link>
                            ) : (
                              t.number
                            )}
                          </td>
                          <td className="num">{amt(t.debit)}</td>
                          <td className="num">{amt(t.credit)}</td>
                        </tr>
                      )),
                    ]
                  : []),
              ]),
              ...(d.detail && !r.parties
                ? [
                    ...(r.opening
                      ? [
                          <tr key={`${r.code}-ob`} className="row-muted small">
                            <td style={{ paddingLeft: 48 }}>Opening balance</td>
                            <td />
                            <td className="num">
                              {r.opening > 0 ? money(r.opening) : ""}
                            </td>
                            <td className="num">
                              {r.opening < 0 ? money(-r.opening) : ""}
                            </td>
                          </tr>,
                        ]
                      : []),
                    ...(r.txns || []).map((t, i) => (
                      <tr key={`${r.code}-${i}`} className="small">
                        <td style={{ paddingLeft: 48 }}>
                          <span className="muted">{date(t.date)}</span> ·{" "}
                          {t.type}
                          {t.party ? ` · ${t.party}` : ""}
                        </td>
                        <td>
                          {t.id ? (
                            <Link to={docLink(t.type, t.id)}>{t.number}</Link>
                          ) : (
                            t.number
                          )}
                        </td>
                        <td className="num">{amt(t.debit)}</td>
                        <td className="num">{amt(t.credit)}</td>
                      </tr>
                    )),
                  ]
                : []),
            ]),
          ];
        })}
        <tr className="row-grand">
          <td colSpan={d.detail ? 2 : 1}>Grand Total</td>
          <td className="num">{money(d.totalDebit)}</td>
          <td className="num">{money(d.totalCredit)}</td>
        </tr>
        {d.view === "tally" && d.closingStock ? (
          <tr>
            <td colSpan={d.detail ? 2 : 1} className="muted">
              Closing Stock (shown in the P&amp;L, not part of the totals, as in
              Tally)
            </td>
            <td className="num muted">{money(d.closingStock)}</td>
            <td />
          </tr>
        ) : null}
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
              <Link to={`/${kind === "ar" ? "customers" : "vendors"}/${r.id}`}>
                {r.name}
              </Link>
            </td>
            {cols.map(([k]) => (
              <td
                key={k}
                className={`num ${k !== "current" && k !== "total" && r[k] ? "text-overdue" : ""}`}
              >
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
            <td className="num">{money(r.amount, r.currency)}</td>
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
            <td className="num">{money(r.amount, r.currency)}</td>
          </tr>
        ))}
        <tr className="row-grand">
          <td colSpan={2}>Total</td>
          <td className="num">{money(d.total, d.currency)}</td>
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
                  {k === "number" && link ? (
                    <Link to={link(r)}>{r.number}</Link>
                  ) : k === "date" ? (
                    date(r.date)
                  ) : k === "placeOfSupply" ? (
                    `${r.placeOfSupply}-${stateName(r.placeOfSupply)}`
                  ) : k === "rate" ? (
                    `${r.rate}%`
                  ) : (
                    r[k]
                  )}
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
      {!d.gstin && (
        <div className="alert alert-error">
          Add your GSTIN in Settings before filing.
        </div>
      )}
      <p className="muted small">
        {d.documents.invoices} invoices and {d.documents.creditNotes} credit
        notes in this period. Drafts and void documents are left out.
      </p>
      <DocTable
        title="4A · B2B Invoices (to registered customers)"
        sec={d.b2b}
        link={inv}
        cols={[
          ["number", "Invoice#"],
          ["date", "Date"],
          ["name", "Customer"],
          ["gstin", "GSTIN"],
          ["placeOfSupply", "Place of Supply"],
        ]}
      />
      <DocTable
        title="5 · B2C Large (inter-state, over ₹1 lakh, unregistered)"
        sec={d.b2cl}
        link={inv}
        cols={[
          ["number", "Invoice#"],
          ["date", "Date"],
          ["name", "Customer"],
          ["placeOfSupply", "Place of Supply"],
        ]}
      />
      <DocTable
        title="7 · B2C Small (by place of supply and rate)"
        sec={d.b2cs}
        cols={[
          ["placeOfSupply", "Place of Supply"],
          ["rate", "Rate"],
        ]}
      />
      <DocTable
        title="9B · Credit Notes – Registered (CDNR)"
        sec={d.cdnr}
        link={cn}
        cols={[
          ["number", "Credit Note#"],
          ["date", "Date"],
          ["name", "Customer"],
          ["gstin", "GSTIN"],
          ["invoiceNumber", "Invoice#"],
        ]}
      />
      <DocTable
        title="9B · Credit Notes – Unregistered (CDNUR)"
        sec={d.cdnur}
        link={cn}
        cols={[
          ["number", "Credit Note#"],
          ["date", "Date"],
          ["name", "Customer"],
          ["invoiceNumber", "Invoice#"],
        ]}
      />
      <DocTable
        title="12 · HSN-wise Summary of Outward Supplies"
        sec={d.hsn}
        cols={[
          ["hsn", "HSN/SAC"],
          ["unit", "UQC"],
          ["quantity", "Quantity"],
          ["rate", "Rate"],
        ]}
      />
      <p className="muted small">
        This is a summary to help you or your CA file GSTR-1. Check it against
        the GST portal before filing.
      </p>
    </>
  );
}

function Gstr3b({ d }) {
  const row = (label, o, taxable = true) => (
    <tr>
      <td>{label}</td>
      <td className="num">
        {taxable && o.taxable !== undefined ? money(o.taxable) : ""}
      </td>
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
          {row("(c) Nil rated and exempted supplies", {
            ...d.nilExempt,
            igst: 0,
            cgst: 0,
            sgst: 0,
          })}
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
        Simplified view: the GST portal sets off IGST credit first against IGST,
        then CGST and SGST, so the final cash payable can differ. ITC includes
        all GST on bills and expenses; exclude blocked credits (e.g. food,
        personal vehicles) when filing. Check with your CA before filing.
      </p>
    </>
  );
}

/* ---------------- Generic renderers (Reports Center catalog) ---------------- */
const isNum = (t) => t === "money" || t === "number";
function Cell({ c, r }) {
  const v = r[c.key];
  if (v === null || v === undefined || v === "")
    return <td className={isNum(c.type) ? "num" : ""} />;
  let content = v;
  if (c.type === "money") content = money(v);
  else if (c.type === "number") content = Number(v).toLocaleString("en-IN");
  else if (c.type === "date") content = date(v);
  else if (c.type === "status") content = <Status value={v} />;
  else if (c.type === "doc" && r.ref)
    content = <Link to={docLink(r.ref.type, r.ref.id)}>{v}</Link>;
  if (c.link && r[c.link]) content = <Link to={r[c.link]}>{content}</Link>;
  return (
    <td className={isNum(c.type) || c.align === "right" ? "num" : ""}>
      {content}
    </td>
  );
}
const sumCol = (rows, c) =>
  Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 100) / 100;
function TotalsRow({ columns, rows, label, cls }) {
  if (!columns.some((c) => c.sum)) return null;
  return (
    <tr className={cls}>
      {columns.map((c, i) => (
        <td key={c.key} className={isNum(c.type) ? "num" : ""}>
          {c.sum
            ? c.type === "money"
              ? money(sumCol(rows, c))
              : sumCol(rows, c).toLocaleString("en-IN")
            : i === 0
              ? label
              : ""}
        </td>
      ))}
    </tr>
  );
}
function TableReport({ d }) {
  const { columns, rows, groupBy } = d;
  if (!rows.length)
    return <p className="muted center">No transactions for this period.</p>;
  const groups = groupBy ? [...new Set(rows.map((r) => r[groupBy]))] : [null];
  return (
    <table className="report-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className={isNum(c.type) || c.align === "right" ? "num" : ""}
            >
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
            g !== null && groups.length > 1 && (
              <TotalsRow
                key={`t-${g}`}
                columns={columns}
                rows={mine}
                label={`Total for ${g}`}
                cls="row-subtotal"
              />
            ),
          ];
        })}
        <TotalsRow
          columns={columns}
          rows={rows}
          label="Total"
          cls="row-grand"
        />
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
    const cls =
      { subtotal: "row-subtotal", total: "row-total", grand: "row-grand" }[
        l.style
      ] || "";
    return (
      <tr className={cls} key={i}>
        <td
          style={
            l.style === "item"
              ? { paddingLeft: 12 + (l.indent || 0) * 18 }
              : undefined
          }
        >
          {label}
        </td>
        <td className="num">
          {l.amount === undefined || l.amount === null ? "" : money(l.amount)}
        </td>
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
      {d.check === false && (
        <div className="alert alert-error">
          The cash flow does not tie to your cash and bank balances — please
          report this.
        </div>
      )}
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
// Tally's horizontal P&L A/c / Balance Sheet: groups on two sides, totals level. Click a group to open
// its ledgers; Detailed (Alt+F5) opens them all.
function TallyStatement({ d, range }) {
  const [open, setOpen] = useState({});
  const [all, setAll] = useState(false);
  // Percentages, as in Tally: P&L against Sales Accounts, Balance Sheet against its total.
  const [pct, setPctState] = useState(() => {
    try {
      return localStorage.getItem("tallyPct") === "1";
    } catch {
      return false;
    }
  });
  const setPct = (v) => {
    setPctState(v);
    try {
      localStorage.setItem("tallyPct", v ? "1" : "0");
    } catch {}
  };
  const isBS = (d.headings || [])[0] === "Liabilities";
  const salesTotal = (d.blocks?.[0]?.right || []).find(
    (g) => g.name === "Sales Accounts",
  )?.amount;
  const basis = isBS ? d.blocks?.[0]?.total : salesTotal || d.blocks?.[0]?.total;
  const pctOf = (v) =>
    v || v === 0
      ? basis
        ? `${((v / basis) * 100).toFixed(2)}%`
        : ""
      : "";
  useEffect(() => {
    const t = () => setAll((x) => !x);
    window.addEventListener("tally:detail", t);
    return () => window.removeEventListener("tally:detail", t);
  }, []);
  const isOpen = (k) => (open[k] === undefined ? all : open[k]);
  const amt = (v) => (v || v === 0 ? money(v).replace("₹", "").trim() : "");
  const stockTo = (name) => {
    if (!/^(opening|closing) stock$/i.test(name || "")) return null;
    const t = d.to ? String(d.to).slice(0, 10) : range.to;
    // Balance Sheet (as at): the financial year up to that date, as Tally does.
    const [y, m] = t.split("-").map(Number);
    const f = d.from
      ? String(d.from).slice(0, 10)
      : `${m >= 4 ? y : y - 1}-04-01`;
    return `/reports/stock-summary?from=${f}&to=${t}`;
  };
  const ledgerTo = (l) =>
    stockTo(l.name) ||
    (l.party
      ? `/reports/party-ledger?party=${l.party}&from=${range.from}&to=${range.to}`
      : acctLink(l.code, range));
  const rowsOf = (groups, side) => {
    const out = [];
    for (const g of groups) {
      const k = `${side}:${g.name}`;
      const stk = stockTo(g.name);
      const can =
        !stk && (g.ledgers || []).length + (g.subgroups || []).length > 0;
      out.push({
        kind: "group",
        label: g.name,
        amount: g.amount,
        k,
        can,
        style: g.style,
        to: stk || undefined,
      });
      if (!can || !isOpen(k)) continue;
      for (const sg of g.subgroups || []) {
        const sk = `${k}:${sg.name}`;
        const scan = (sg.ledgers || []).length > 0;
        out.push({
          kind: "sub",
          label: sg.name,
          inner: sg.amount,
          k: sk,
          can: scan,
        });
        if (scan && isOpen(sk))
          for (const l of sg.ledgers)
            out.push({
              kind: "ledger2",
              label: l.name,
              inner: l.amount,
              to: ledgerTo(l),
            });
      }
      for (const l of g.ledgers || [])
        out.push({
          kind: "ledger",
          label: l.name,
          inner: l.amount,
          to: ledgerTo(l),
        });
    }
    return out;
  };
  const cells = (r, sep = "") => {
    if (!r)
      return [
        <td key="a" className={`th-p${sep}`} />,
        <td key="b" className="num" />,
        <td key="c" className="num th-amt" />,
        ...(pct ? [<td key="d" className="num th-pct" />] : []),
      ];
    const label = r.to ? <Link to={r.to}>{r.label}</Link> : r.label;
    const toggle = r.can
      ? () => setOpen((o) => ({ ...o, [r.k]: !isOpen(r.k) }))
      : undefined;
    return [
      <td
        key="a"
        className={`th-p th-${r.kind}${r.style ? ` th-${r.style}` : ""}${toggle ? " th-click" : ""}${sep}`}
        onClick={toggle}
        title={toggle ? (isOpen(r.k) ? "Close" : "Show ledgers") : undefined}
      >
        {label}
      </td>,
      <td key="b" className="num th-inner">
        {r.inner !== undefined ? amt(r.inner) : ""}
      </td>,
      <td
        key="c"
        className={`num th-amt${r.kind === "group" ? " th-bold" : ""}`}
      >
        {r.amount !== undefined ? amt(r.amount) : ""}
      </td>,
      ...(pct
        ? [
            <td key="d" className="num th-pct">
              {pctOf(r.amount !== undefined ? r.amount : r.inner)}
            </td>,
          ]
        : []),
    ];
  };
  const [lh, rh] = d.headings || ["Particulars", "Particulars"];
  return (
    <div data-views>
      <div className="muted small no-print" style={{ marginBottom: 6 }}>
        Click a group to see its ledgers ·{" "}
        <button
          type="button"
          className="link-btn"
          onClick={() => (setOpen({}), setAll((x) => !x))}
        >
          {all ? "Condensed" : "Detailed"} (Alt+F5)
        </button>{" "}
        ·{" "}
        <button type="button" className="link-btn" onClick={() => setPct(!pct)}>
          {pct ? "Hide percentages" : "Show percentages"}
        </button>
        {pct && (
          <span>
            {" "}
            (of {isBS ? "the total" : salesTotal ? "Sales Accounts" : "the total"}
            , as in Tally)
          </span>
        )}
      </div>
      <table className="tally-h">
        <colgroup>
          <col />
          <col className="c-inner" />
          <col className="c-amt" />
          {pct && <col className="c-pct" />}
          <col />
          <col className="c-inner" />
          <col className="c-amt" />
          {pct && <col className="c-pct" />}
        </colgroup>
        <thead>
          <tr>
            <th>{lh}</th>
            <th />
            <th className="num">{d.from ? "" : `as at ${date(d.to)}`}</th>
            {pct && <th className="num">%</th>}
            <th className="th-sep">{rh}</th>
            <th />
            <th className="num">{d.from ? "" : `as at ${date(d.to)}`}</th>
            {pct && <th className="num">%</th>}
          </tr>
        </thead>
        {d.blocks.map((b, bi) => {
          const L = rowsOf(b.left, `l${bi}`);
          const R = rowsOf(b.right, `r${bi}`);
          const n = Math.max(L.length, R.length);
          return (
            <tbody key={bi}>
              {Array.from({ length: n }, (_, i) => (
                <tr key={i}>
                  {cells(L[i])}
                  {cells(R[i], " th-sep")}
                </tr>
              ))}
              <tr className="th-total">
                <td className="th-p">Total</td>
                <td />
                <td className="num th-amt">{amt(b.total)}</td>
                {pct && <td className="num th-pct">{pctOf(b.total)}</td>}
                <td className="th-p th-sep">Total</td>
                <td />
                <td className="num th-amt">{amt(b.total)}</td>
                {pct && <td className="num th-pct">{pctOf(b.total)}</td>}
              </tr>
            </tbody>
          );
        })}
      </table>
      {d.diff ? (
        <div className="alert alert-error">
          The balance sheet is out by {money(Math.abs(d.diff))} — please report
          this.
        </div>
      ) : null}
    </div>
  );
}

function GenericReport(p) {
  if (p.d.kind === "tally") return <TallyStatement {...p} />;
  if (p.d.kind === "statement") return <StatementReport {...p} />;
  if (p.d.kind === "horizontal") return <HorizontalReport {...p} />;
  return (
    <>
      <TableReport {...p} />
      {p.d.note && <p className="muted small report-note">{p.d.note}</p>}
    </>
  );
}

// Bills unpaid over 180 days: B2B (registered suppliers, with GSTIN) and B2C (unregistered) on separate tabs.
function Bills180({ d, range }) {
  const [tab, setTab] = useState("b2b");
  const n = (k) => d.rows.filter((r) => r.kind === k).length;
  return (
    <>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[
          ["b2b", "B2B invoices", "registered suppliers"],
          ["b2c", "B2C invoices", "unregistered suppliers"],
        ].map(([k, l, hint]) => (
          <button
            key={k}
            type="button"
            className={`tab ${tab === k ? "active" : ""}`}
            title={hint}
            onClick={() => setTab(k)}
          >
            {l} <span className="tab-count">{n(k)}</span>
          </button>
        ))}
      </div>
      <TableReport
        d={{ ...d, rows: d.rows.filter((r) => r.kind === tab) }}
        range={range}
      />
      {d.note && (
        <p className="muted small report-note">
          {d.note}
          {tab === "b2c"
            ? " Bills from unregistered suppliers usually carry no GST, so there's no ITC to reverse on them."
            : ""}
        </p>
      )}
    </>
  );
}

// Party Ledger, laid out as Tally's ledger account.
function PartyLedger({ d }) {
  if (!d.party)
    return (
      <p className="muted center">
        Choose a customer or vendor above to see their ledger.
      </p>
    );
  const drcr = (v) =>
    v ? `${money(Math.abs(v))} ${v > 0 ? "Dr" : "Cr"}` : money(0);
  const p = d.party;
  return (
    <>
      <div className="small" style={{ marginBottom: 10 }}>
        {[
          p.company && p.company !== p.name ? p.company : "",
          p.address,
          p.gstin && `GSTIN ${p.gstin}`,
          p.phone,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <table className="report-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Particulars</th>
            <th>Vch Type</th>
            <th>Vch No.</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="row-subtotal">
            <td />
            <td>Opening Balance</td>
            <td />
            <td />
            <td className="num">{d.opening > 0 ? money(d.opening) : ""}</td>
            <td className="num">{d.opening < 0 ? money(-d.opening) : ""}</td>
            <td className="num">{drcr(d.opening)}</td>
          </tr>
          {d.rows.map((r, i) => (
            <tr key={i}>
              <td>{date(r.date)}</td>
              <td>
                {r.particulars || "—"}
                {r.more > 0 && (
                  <span className="muted small"> +{r.more} more</span>
                )}
              </td>
              <td>{r.vchType}</td>
              <td>
                {r.ref?.id ? (
                  <Link to={docLink(r.ref.type, r.ref.id)}>{r.number}</Link>
                ) : (
                  r.number
                )}
              </td>
              <td className="num">{r.debit ? money(r.debit) : ""}</td>
              <td className="num">{r.credit ? money(r.credit) : ""}</td>
              <td className="num">{drcr(r.balance)}</td>
            </tr>
          ))}
          {!d.rows.length && (
            <tr>
              <td colSpan={7} className="muted center">
                No vouchers in this period.
              </td>
            </tr>
          )}
          <tr className="row-subtotal">
            <td />
            <td>Current Total</td>
            <td />
            <td />
            <td className="num">{money(d.debit)}</td>
            <td className="num">{money(d.credit)}</td>
            <td />
          </tr>
          <tr className="row-grand">
            <td />
            <td>Closing Balance</td>
            <td />
            <td />
            <td className="num">{d.closing > 0 ? money(d.closing) : ""}</td>
            <td className="num">{d.closing < 0 ? money(-d.closing) : ""}</td>
            <td className="num">{drcr(d.closing)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

const BODIES = {
  "party-ledger": PartyLedger,
  "bills-180-days": Bills180,
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

// Like Tally: the opening stock the books show (Tally's Opening Stock ledger) and closing stock typed in for a date.
// They change only P&L, Balance Sheet and Trial Balance — items' stock and the Stock Summary stay as they are.
function StockValues({ onClose, onSaved }) {
  const [d, setD] = useState(null);
  const [opening, setOpening] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/organization/stock-values").then((r) => {
      setD(r.data);
      setOpening(r.data.openingStock ?? "");
      setRows(
        (r.data.closingStock || []).map((c) => ({
          date: String(c.date).slice(0, 10),
          amount: c.amount,
        })),
      );
    });
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/organization/stock-values", {
        openingStock: opening === "" ? null : Number(opening),
        closingStock: rows
          .filter((r) => r.date && r.amount !== "")
          .map((r) => ({ date: r.date, amount: Number(r.amount) })),
      });
      onSaved();
    } catch (e) {
      alert(errMsg(e));
    }
    setBusy(false);
  };
  const inr = (n) =>
    `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return (
    <Modal
      open
      title="Stock values in P&L, Balance Sheet and Trial Balance"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !d}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {!d ? (
        <Spinner />
      ) : (
        <div className="form-grid">
          <p className="small muted" style={{ margin: 0 }}>
            As in Tally: these change only the P&L, Balance Sheet and Trial
            Balance. Items' stock and the Stock Summary stay as they are.
          </p>
          <label className="field">
            <span className="field-label">
              Opening stock as per books (on {date(d.openingDate)})
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder={`items' value ${inr(d.itemsOpening)}`}
            />
            <span className="field-hint">
              Items' opening values add up to {inr(d.itemsOpening)}.
              {opening !== "" &&
                Math.abs(Number(opening) - d.itemsOpening) >= 0.01 &&
                ` The difference of ${inr(Number(opening) - d.itemsOpening)} goes to "Opening Stock Difference (Tally)" against Opening Balance Equity, shown as part of Opening Stock.`}{" "}
              Leave blank to use the items' values.
            </span>
          </label>
          <div>
            <div className="field-label">Closing stock entered by hand</div>
            <p className="small muted" style={{ margin: "2px 0 6px" }}>
              A report to a date uses the latest value on or before it; with
              none, closing stock is worked out from the items.
            </p>
            <table className="table">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="date"
                        value={r.date}
                        onChange={(e) =>
                          setRows(
                            rows.map((x, j) =>
                              j === i ? { ...x, date: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={r.amount}
                        onChange={(e) =>
                          setRows(
                            rows.map((x, j) =>
                              j === i ? { ...x, amount: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="Closing stock ₹"
                      />
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        title="Remove"
                        onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setRows([...rows, { date: isoDate(), amount: "" }])
              }
            >
              + Add closing stock for a date
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
