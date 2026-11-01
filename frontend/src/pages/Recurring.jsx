import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, Empty, toast, Confirm } from "../components/ui";
import Icon from "../components/Icon";
import { freqLabel } from "../components/Schedule";

export const REC = {
  invoice: { kind: "invoice", title: "Recurring Invoices", one: "Recurring Invoice", route: "/recurring-invoices", party: "Customer", docRoute: "/invoices", text: "Bill retainers, rent, subscriptions and AMCs automatically on a schedule." },
  bill: { kind: "bill", title: "Recurring Bills", one: "Recurring Bill", route: "/recurring-bills", party: "Vendor", docRoute: "/bills", text: "Record rent, utilities and regular supplier bills automatically." },
  expense: { kind: "expense", title: "Recurring Expenses", one: "Recurring Expense", route: "/recurring-expenses", party: "Vendor / Account", docRoute: "/expenses", text: "Record regular spending — subscriptions, salaries, internet — on a schedule." },
};
const docHref = (r, id) => (r.kind === "expense" ? `/expenses/${id}/edit` : `${r.docRoute}/${id}`);
const statusCls = { active: "paid", stopped: "draft", expired: "void" };
const statusLabel = { active: "Active", stopped: "Stopped", expired: "Expired" };

export function RecurringList({ kind }) {
  const r = REC[kind];
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    setRows(null);
    api.get("/recurring", { params: { kind } }).then((x) => setRows(x.data));
  }, [kind]);
  return (
    <>
      <PageHeader title={r.title}>
        <Link to={`${r.route}/new`} className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="doc"
          title={`No ${r.title.toLowerCase()} yet`}
          text={r.text}
          action={
            <Link to={`${r.route}/new`} className="btn btn-primary">
              New {r.one}
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>{r.party}</th>
                <th>Profile Name</th>
                <th>Frequency</th>
                <th>Last Created</th>
                <th>Next Date</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p._id} onClick={() => navigate(`${r.route}/${p._id}`)}>
                  <td className="strong">{p.partyName}</td>
                  <td className="link">{p.name}</td>
                  <td>{freqLabel(p)}</td>
                  <td>{p.occurrences ? date(lastDate(p)) : "—"}</td>
                  <td>{p.status === "active" ? date(p.nextDate) : "—"}</td>
                  <td>
                    <span className={`status status-${statusCls[p.status]}`}>{statusLabel[p.status]}</span>
                    {p.lastError && <div className="text-danger small" title={p.lastError}>Last run failed</div>}
                  </td>
                  <td className="num">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
// Date of the most recent occurrence (start + (n-1) steps), worked out without history.
function lastDate(p) {
  const s = new Date(p.startDate);
  const n = (p.occurrences - 1) * p.every;
  if (p.unit === "day" || p.unit === "week") return new Date(s.getTime() + n * (p.unit === "week" ? 7 : 1) * 86400000);
  const m = p.unit === "year" ? n * 12 : n;
  const last = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + m, Math.min(s.getUTCDate(), last)));
}

export function RecurringView({ kind }) {
  const r = REC[kind];
  const { id } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => api.get(`/recurring/${id}`).then((x) => setP(x.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Spinner />;
  const setStatus = async (status) => {
    try {
      const { data } = await api.post(`/recurring/${id}/status`, { status });
      setP(data);
      toast(status === "active" ? "Profile resumed" : "Profile stopped");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const remove = async () => {
    await api.delete(`/recurring/${id}`);
    toast("Recurring profile deleted");
    navigate(r.route);
  };
  const info = (label, value) => (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
  return (
    <>
      <PageHeader title={p.name} subtitle={`${r.one} · ${p.partyName}`} back={r.route}>
        {p.status === "active" ? (
          <button className="btn" onClick={() => setStatus("stopped")}>
            Stop
          </button>
        ) : p.status === "stopped" ? (
          <button className="btn" onClick={() => setStatus("active")}>
            Resume
          </button>
        ) : null}
        <Link to={`${r.route}/${id}/edit`} className="btn btn-primary">
          Edit
        </Link>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card">
        <div className="stats-row">
          {info("Status", <span className={`status status-${statusCls[p.status]}`}>{statusLabel[p.status]}</span>)}
          {info("Frequency", freqLabel(p))}
          {info("Start Date", date(p.startDate))}
          {info("End Date", p.endDate ? date(p.endDate) : "Never expires")}
          {info("Next Date", p.status === "active" ? date(p.nextDate) : "—")}
          {info("Amount", money(p.amount))}
          {kind !== "expense" && info("Payment Terms", p.paymentTerms ? `Net ${p.paymentTerms}` : "Due on receipt")}
          {kind !== "expense" && info("Created As", p.createAs === "draft" ? "Draft" : kind === "invoice" ? "Sent" : "Open")}
        </div>
        {p.lastError && <div className="alert alert-error" style={{ marginTop: 12 }}>Couldn't create the {kind} for {p.lastError}</div>}
      </div>
      {kind !== "expense" && (
        <div className="card flush">
          <h3 className="card-title pad">Items</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Rate</th>
                <th className="num">GST</th>
              </tr>
            </thead>
            <tbody>
              {(p.template.lineItems || []).map((l, i) => (
                <tr key={i}>
                  <td>{l.name}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{money(l.rate)}</td>
                  <td className="num">{l.taxRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card flush">
        <h3 className="card-title pad">Created {kind === "invoice" ? "Invoices" : kind === "bill" ? "Bills" : "Expenses"}</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Number</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...p.history].reverse().map((h) => (
              <tr key={String(h.id)}>
                <td>{date(h.date)}</td>
                <td>
                  <Link to={docHref(r, h.id)}>{h.number}</Link>
                </td>
                <td className="num">{money(h.total)}</td>
              </tr>
            ))}
            {!p.history.length && (
              <tr>
                <td colSpan={3} className="muted center">
                  Nothing created yet. The first one is created on {date(p.nextDate)}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Confirm open={confirm} title="Delete recurring profile?" text={`${kind === "invoice" ? "Invoices" : kind === "bill" ? "Bills" : "Expenses"} it already created are kept.`} onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}
