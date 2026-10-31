import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date } from "../lib/format";
import { Spinner, Status } from "../components/ui";
import Icon from "../components/Icon";

function compact(n) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
}

function SalesChart({ months }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.sales, m.receipts)));
  const W = 640;
  const H = 220;
  const pad = { l: 48, r: 8, t: 10, b: 28 };
  const bw = (W - pad.l - pad.r) / months.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Sales and receipts, last 12 months">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
          <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="chart-axis">
            {compact(t)}
          </text>
        </g>
      ))}
      {months.map((m, i) => {
        const x = pad.l + i * bw + bw * 0.18;
        const w = (bw * 0.64) / 2 - 1;
        return (
          <g key={m.key}>
            <rect x={x} y={y(m.sales)} width={w} height={H - pad.b - y(m.sales)} rx="3" className="bar-sales">
              <title>{`${m.label} ${m.year} — Sales ${money(m.sales)}`}</title>
            </rect>
            <rect x={x + w + 2} y={y(m.receipts)} width={w} height={H - pad.b - y(m.receipts)} rx="3" className="bar-receipts">
              <title>{`${m.label} ${m.year} — Receipts ${money(m.receipts)}`}</title>
            </rect>
            <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="chart-axis">
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const { user, organization } = useAuth();
  const [d, setD] = useState(null);

  useEffect(() => {
    api.get("/dashboard").then((r) => setD(r.data));
  }, []);

  if (!d) return <Spinner />;
  const r = d.receivables;
  const overduePct = r.total ? (r.overdue / r.total) * 100 : 0;
  const isNew = d.counts.invoices === 0 && d.counts.customers === 0;

  return (
    <div className="dashboard">
      <div className="hello">
        <div>
          <h1>Hello, {user?.name?.split(" ")[0]}</h1>
          <p className="muted">{organization?.name}</p>
        </div>
      </div>

      {isNew && (
        <div className="card getting-started">
          <h3>Get started with MGI</h3>
          <div className="steps">
            <Link to="/settings" className="step">
              <span className="step-n">1</span> Add your GSTIN and address
            </Link>
            <Link to="/customers/new" className="step">
              <span className="step-n">2</span> Add a customer
            </Link>
            <Link to="/items/new" className="step">
              <span className="step-n">3</span> Add an item
            </Link>
            <Link to="/invoices/new" className="step">
              <span className="step-n">4</span> Create your first invoice
            </Link>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Total Receivables</h3>
          <Link to="/invoices/new" className="link-btn">
            <Icon name="plus" size={14} /> New
          </Link>
        </div>
        <p className="muted small">Total unpaid invoices {money(r.total)}</p>
        <div className="meter">
          <div className="meter-current" style={{ width: `${100 - overduePct}%` }} />
          <div className="meter-overdue" style={{ width: `${overduePct}%` }} />
        </div>
        <div className="recv-grid">
          <div>
            <span className="label label-current">Current</span>
            <strong>{money(r.current)}</strong>
          </div>
          <div>
            <span className="label label-overdue">Overdue</span>
            <strong>{money(r.overdue)}</strong>
          </div>
          {Object.entries(r.buckets).map(([k, v]) => (
            <div key={k}>
              <span className="label">{k} days</span>
              <strong className={v ? "text-overdue" : ""}>{money(v)}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Sales and Receipts</h3>
            <span className="muted small">Last 12 months</span>
          </div>
          <div className="legend">
            <span>
              <i className="dot dot-sales" /> Sales
            </span>
            <span>
              <i className="dot dot-receipts" /> Receipts
            </span>
          </div>
          <SalesChart months={d.months} />
          <div className="kpis">
            <div>
              <span className="muted small">Sales this financial year</span>
              <strong>{money(d.salesThisFy)}</strong>
            </div>
            <div>
              <span className="muted small">Received this financial year</span>
              <strong>{money(d.receiptsThisFy)}</strong>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Top Customers by Dues</h3>
          </div>
          {d.topDebtors.length === 0 ? (
            <p className="muted">No outstanding dues. Nice.</p>
          ) : (
            <ul className="rank">
              {d.topDebtors.map((t) => (
                <li key={t.customer}>
                  <Link to={`/customers/${t.customer}`}>{t.name}</Link>
                  <strong>{money(t.balance)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Recent Invoices</h3>
          <Link to="/invoices" className="link-btn">
            View all
          </Link>
        </div>
        {d.recentInvoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice#</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">Balance Due</th>
              </tr>
            </thead>
            <tbody>
              {d.recentInvoices.map((i) => (
                <tr key={i._id}>
                  <td>{date(i.date)}</td>
                  <td>
                    <Link to={`/invoices/${i._id}`}>{i.invoiceNumber}</Link>
                  </td>
                  <td>{i.customerName}</td>
                  <td>
                    <Status value={i.displayStatus} />
                  </td>
                  <td className="num">{money(i.total)}</td>
                  <td className="num">{money(i.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
