import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, amount } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

const COUNT = { monthly: 12, quarterly: 4, yearly: 1 };
const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const labels = (fy, period) =>
  period === "monthly" ? MONTHS.map((m, i) => `${m} ${String(i < 9 ? fy : fy + 1).slice(2)}`) : period === "quarterly" ? ["Q1", "Q2", "Q3", "Q4"] : [`FY ${fy}-${String(fy + 1).slice(2)}`];
const currentFy = () => {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};
const fyLabel = (y) => `FY ${y}-${String(y + 1).slice(2)} (Apr ${y} – Mar ${y + 1})`;

export function BudgetList() {
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.get("/budgets").then((r) => setRows(r.data));
  }, []);
  return (
    <>
      <PageHeader title="Budgets">
        <Link to="/budgets/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New Budget
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="chart"
          title="No budgets yet"
          text="Plan income and expenses for the year by month or quarter, then track actuals against it."
          action={
            <Link to="/budgets/new" className="btn btn-primary">
              New Budget
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Name</th>
                <th>Financial Year</th>
                <th>Period</th>
                <th className="num">Accounts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b._id} onClick={() => navigate(`/budgets/${b._id}`)}>
                  <td className="strong link">{b.name}</td>
                  <td>{fyLabel(b.fiscalYear)}</td>
                  <td style={{ textTransform: "capitalize" }}>{b.period}</td>
                  <td className="num">{b.lines.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function BudgetForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(null);
  const [form, setForm] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.get("/accounts").then(async (r) => {
      setAccounts(r.data);
      if (id) {
        const { data } = await api.get(`/budgets/${id}`);
        setForm({ name: data.name, fiscalYear: data.fiscalYear, period: data.period, values: Object.fromEntries(data.lines.map((l) => [l.account, l.amounts.map((x) => (x ? String(x) : ""))])) });
      } else setForm({ name: "", fiscalYear: currentFy(), period: "monthly", values: {} });
    });
  }, [id]);
  if (!form || !accounts) return <Spinner />;
  const n = COUNT[form.period];
  const cols = labels(Number(form.fiscalYear), form.period);
  const shown = accounts.filter((a) => showAll || ["income", "expense"].includes(a.type) || form.values[a.code]);
  const groups = ["income", "expense", "asset", "liability", "equity"].map((t) => [t, shown.filter((a) => a.type === t)]).filter(([, l]) => l.length);
  const val = (code, i) => (form.values[code] || [])[i] ?? "";
  const setVal = (code, i, v) => {
    const arr = [...(form.values[code] || Array(n).fill(""))];
    arr[i] = v;
    setForm({ ...form, values: { ...form.values, [code]: arr } });
  };
  const fill = (code) => {
    const first = val(code, 0);
    setForm({ ...form, values: { ...form.values, [code]: Array(n).fill(first) } });
  };
  const rowTotal = (code) => (form.values[code] || []).slice(0, n).reduce((s, x) => s + (Number(x) || 0), 0);
  const changePeriod = (p) => {
    // Re-spread amounts when the period changes, keeping each account's yearly total.
    const m = COUNT[p];
    const values = Object.fromEntries(Object.entries(form.values).map(([k, arr]) => {
      const total = arr.slice(0, n).reduce((s, x) => s + (Number(x) || 0), 0);
      return [k, total ? Array(m).fill(String(Math.round((total / m) * 100) / 100)) : []];
    }));
    setForm({ ...form, period: p, values });
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { name: form.name, fiscalYear: Number(form.fiscalYear), period: form.period, lines: Object.entries(form.values).map(([account, a]) => ({ account, amounts: a.slice(0, n).map((x) => Number(x) || 0) })) };
      const { data } = id ? await api.put(`/budgets/${id}`, body) : await api.post("/budgets", body);
      toast(id ? "Budget updated" : "Budget created");
      navigate(`/budgets/${data._id}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  const fy = currentFy();
  return (
    <>
      <PageHeader title={id ? `Edit ${form.name}` : "New Budget"} back={id ? `/budgets/${id}` : "/budgets"} />
      <div className="card form">
        <div className="form-grid">
          <div className="row-3">
            <Field label="Budget Name" required>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Financial Year" required>
              <select value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: Number(e.target.value) })}>
                {[fy - 2, fy - 1, fy, fy + 1, fy + 2].map((y) => (
                  <option key={y} value={y}>
                    {fyLabel(y)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Budget Period">
              <select value={form.period} onChange={(e) => changePeriod(e.target.value)}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Also show asset, liability and equity accounts
          </label>
        </div>
        <div className="budget-grid-wrap">
          <table className="table budget-grid">
            <thead>
              <tr>
                <th>Account</th>
                {cols.map((c) => (
                  <th key={c} className="num">
                    {c}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([t, list]) => [
                <tr key={t} className="row-section">
                  <td colSpan={n + 2} style={{ textTransform: "capitalize" }}>
                    {t}
                  </td>
                </tr>,
                ...list.map((a) => (
                  <tr key={a.code}>
                    <td className="nowrap">
                      {a.name}
                      {n > 1 && (
                        <button type="button" className="link-btn small" title="Copy the first amount to every period" onClick={() => fill(a.code)}>
                          fill →
                        </button>
                      )}
                    </td>
                    {cols.map((c, i) => (
                      <td key={c}>
                        <input type="number" step="0.01" value={val(a.code, i)} onChange={(e) => setVal(a.code, i, e.target.value)} />
                      </td>
                    ))}
                    <td className="num strong">{rowTotal(a.code) ? amount(rowTotal(a.code)) : ""}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy || !form.name} onClick={save}>
            Save
          </button>
          <button className="btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

export function BudgetView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [view, setView] = useState("periods");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    api.get(`/budgets/${id}/actuals`).then((r) => setD(r.data));
  }, [id]);
  if (!d) return <Spinner />;
  const good = (r, b, a) => (r.type === "income" ? a >= b : a <= b);
  const varCell = (r, b, a) => {
    const v = Math.round((a - b) * 100) / 100;
    if (!b && !a) return <span className="muted">—</span>;
    return <span className={good(r, b, a) ? "text-good" : "text-danger"}>{v > 0 ? "+" : ""}{amount(v)}</span>;
  };
  const sumBy = (type, key, i) => d.rows.filter((r) => r.type === type).reduce((s, r) => s + (i === undefined ? r[key] : r[key][i]), 0);
  const types = ["income", "expense"].filter((t) => d.rows.some((r) => r.type === t));
  const others = d.rows.filter((r) => !["income", "expense"].includes(r.type));
  const remove = async () => {
    await api.delete(`/budgets/${id}`);
    toast("Budget deleted");
    navigate("/budgets");
  };
  const Row = ({ r }) => (
    <tr>
      <td className="nowrap">
        <Link to={`/chart-of-accounts/${encodeURIComponent(r.code)}`}>{r.name}</Link>
      </td>
      {view === "periods" &&
        d.periods.map((p, i) => (
          <td key={i} className="num bva">
            <div>{amount(r.actual[i])}</div>
            <div className="muted small">of {amount(r.budget[i])}</div>
          </td>
        ))}
      <td className="num">{money(r.totalBudget)}</td>
      <td className="num">{money(r.totalActual)}</td>
      <td className="num">{varCell(r, r.totalBudget, r.totalActual)}</td>
      <td className="num">{r.totalBudget ? `${Math.round((r.totalActual / r.totalBudget) * 100)}%` : "—"}</td>
    </tr>
  );
  return (
    <>
      <PageHeader title={d.budget.name} subtitle={`Budget vs Actuals · ${fyLabel(d.budget.fiscalYear)} · ${d.budget.period}`} back="/budgets">
        <select className="select-inline" value={view} onChange={(e) => setView(e.target.value)}>
          <option value="periods">Show each period</option>
          <option value="total">Year totals only</option>
        </select>
        <Link to={`/budgets/${id}/edit`} className="btn">
          Edit
        </Link>
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print
        </button>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="report-paper">
        <div className="budget-grid-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Account</th>
                {view === "periods" &&
                  d.periods.map((p) => (
                    <th key={p.label} className="num">
                      {p.label}
                    </th>
                  ))}
                <th className="num">Budget</th>
                <th className="num">Actual</th>
                <th className="num">Variance</th>
                <th className="num">Achieved</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => [
                <tr key={t} className="row-section">
                  <td colSpan={99}>{t === "income" ? "Income" : "Expenses"}</td>
                </tr>,
                ...d.rows.filter((r) => r.type === t).map((r) => <Row key={r.code} r={r} />),
                <tr key={`${t}-tot`} className="row-subtotal">
                  <td>Total {t === "income" ? "Income" : "Expenses"}</td>
                  {view === "periods" &&
                    d.periods.map((p, i) => (
                      <td key={i} className="num bva">
                        <div>{amount(sumBy(t, "actual", i))}</div>
                        <div className="muted small">of {amount(sumBy(t, "budget", i))}</div>
                      </td>
                    ))}
                  <td className="num">{money(sumBy(t, "totalBudget"))}</td>
                  <td className="num">{money(sumBy(t, "totalActual"))}</td>
                  <td className="num">{varCell({ type: t }, sumBy(t, "totalBudget"), sumBy(t, "totalActual"))}</td>
                  <td />
                </tr>,
              ])}
              {types.length === 2 && (
                <tr className="row-grand">
                  <td>Net Profit</td>
                  {view === "periods" &&
                    d.periods.map((p, i) => (
                      <td key={i} className="num bva">
                        <div>{amount(sumBy("income", "actual", i) - sumBy("expense", "actual", i))}</div>
                        <div className="muted small">of {amount(sumBy("income", "budget", i) - sumBy("expense", "budget", i))}</div>
                      </td>
                    ))}
                  <td className="num">{money(sumBy("income", "totalBudget") - sumBy("expense", "totalBudget"))}</td>
                  <td className="num">{money(sumBy("income", "totalActual") - sumBy("expense", "totalActual"))}</td>
                  <td className="num">{varCell({ type: "income" }, sumBy("income", "totalBudget") - sumBy("expense", "totalBudget"), sumBy("income", "totalActual") - sumBy("expense", "totalActual"))}</td>
                  <td />
                </tr>
              )}
              {others.length > 0 && [
                <tr key="oth" className="row-section">
                  <td colSpan={99}>Balance sheet accounts (movement in period)</td>
                </tr>,
                ...others.map((r) => <Row key={r.code} r={r} />),
              ]}
            </tbody>
          </table>
        </div>
        <p className="muted small report-note">Actuals are the movement in each account during the period. Green = on the right side of budget (income above, spending below).</p>
      </div>
      <Confirm open={confirm} title="Delete budget?" text="This can't be undone." onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}
