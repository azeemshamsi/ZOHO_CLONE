import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { GST_RATES } from "../lib/constants";
import { PERIODS, periodRange } from "../lib/period";
import { PageHeader, Spinner, Empty, Field, Modal, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

const METHODS = [
  ["project_hours", "Based on Project Hours", "One hourly rate for the whole project"],
  ["task_hours", "Based on Task Hours", "Each task has its own hourly rate"],
  ["staff_hours", "Based on Staff Hours", "Each person has their own hourly rate"],
  ["fixed", "Fixed Cost for Project", "Bill an agreed project fee, in one go or in parts"],
];
const methodName = (k) => METHODS.find((m) => m[0] === k)?.[1] || k;
export const fmtHours = (h) => {
  const m = Math.round((Number(h) || 0) * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/* ============================ Projects ============================ */
export function ProjectList() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("active");
  const navigate = useNavigate();
  useEffect(() => {
    setRows(null);
    api.get("/projects", { params: { status: status || undefined } }).then((r) => setRows(r.data));
  }, [status]);
  return (
    <>
      <PageHeader title="Projects">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active Projects</option>
          <option value="inactive">Inactive Projects</option>
          <option value="">All Projects</option>
        </select>
        <Link to="/projects/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="doc"
          title="No projects yet"
          text="Track time against customer projects and turn it into invoices — or bill a fixed project fee."
          action={
            <Link to="/projects/new" className="btn btn-primary">
              New Project
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Customer</th>
                <th>Billing Method</th>
                <th className="num">Logged Hours</th>
                <th className="num">Unbilled Hours</th>
                <th className="num">Unbilled Amount</th>
                <th className="num">Invoiced</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p._id} onClick={() => navigate(`/projects/${p._id}`)}>
                  <td className="strong link">
                    {p.name}
                    {p.code && <span className="muted small"> · {p.code}</span>}
                  </td>
                  <td>{p.customerName}</td>
                  <td>{methodName(p.billingMethod)}</td>
                  <td className="num">{fmtHours(p.summary.loggedHours)}</td>
                  <td className="num">{fmtHours(p.summary.unbilledHours)}</td>
                  <td className="num">{p.billingMethod === "fixed" ? money(p.summary.fixedRemaining) : money(p.summary.unbilledAmount)}</td>
                  <td className="num">{money(p.summary.invoicedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function ProjectForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    api.get("/customers", { params: { status: "active" } }).then((r) => setCustomers(r.data));
    // Only admins can list users; others just see themselves.
    api
      .get("/users")
      .then((r) => setUsers(r.data.filter((u) => u.status === "active")))
      .catch(() => setUsers(user ? [{ _id: user._id, name: user.name }] : []));
    if (id)
      api.get(`/projects/${id}`).then(({ data }) =>
        setForm({ ...data, customer: data.customer, users: data.users.map((u) => ({ user: u.user, rate: u.rate })), tasks: data.tasks.map((t) => ({ ...t })) })
      );
    else
      setForm({
        name: "",
        code: "",
        customer: params.get("customer") || "",
        description: "",
        billingMethod: "project_hours",
        fixedAmount: "",
        rate: "",
        budgetHours: "",
        budgetAmount: "",
        taxRate: 18,
        sac: "998311",
        status: "active",
        tasks: [{ name: "", description: "", rate: "", billable: true }],
        users: user ? [{ user: user._id, rate: "" }] : [],
      });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setTask = (i, k, v) => setForm({ ...form, tasks: form.tasks.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });
  const setUser = (i, k, v) => setForm({ ...form, users: form.users.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });
  const m = form.billingMethod;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        name: form.name,
        code: form.code,
        customer: form.customer,
        description: form.description,
        billingMethod: m,
        fixedAmount: Number(form.fixedAmount || 0),
        rate: Number(form.rate || 0),
        budgetHours: Number(form.budgetHours || 0),
        budgetAmount: Number(form.budgetAmount || 0),
        taxRate: Number(form.taxRate),
        sac: form.sac,
        status: form.status,
        tasks: form.tasks.filter((t) => t.name.trim()).map((t) => ({ _id: t._id || "", name: t.name, description: t.description || "", rate: Number(t.rate || 0), billable: t.billable !== false })),
        users: form.users.filter((u) => u.user).map((u) => ({ user: u.user, rate: Number(u.rate || 0) })),
      };
      const { data } = id ? await api.put(`/projects/${id}`, body) : await api.post("/projects", body);
      toast(id ? "Project updated" : "Project created");
      navigate(`/projects/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? `Edit ${form.name}` : "New Project"} back={id ? `/projects/${id}` : "/projects"} />
      <form className="card form" onSubmit={save}>
        <div className="form-grid">
          <div className="row-2">
            <Field label="Project Name" required>
              <input required value={form.name} onChange={set("name")} autoFocus />
            </Field>
            <Field label="Project Code">
              <input value={form.code} onChange={set("code")} />
            </Field>
          </div>
          <Field label="Customer" required>
            <select required value={form.customer} onChange={set("customer")}>
              <option value="">Select a customer</option>
              {customers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Billing Method" required>
            <div className="role-grid">
              {METHODS.map(([k, l, d]) => (
                <label key={k} className={`role-card ${m === k ? "on" : ""}`}>
                  <input type="radio" checked={m === k} onChange={() => setForm({ ...form, billingMethod: k })} />
                  <span>
                    <strong>{l}</strong>
                    <div className="muted small">{d}</div>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <div className="row-3">
            {m === "fixed" && (
              <Field label="Project Fee (₹)" required hint="Before GST">
                <input type="number" step="0.01" min="0" required value={form.fixedAmount} onChange={set("fixedAmount")} />
              </Field>
            )}
            {m === "project_hours" && (
              <Field label="Rate per Hour (₹)" required>
                <input type="number" step="0.01" min="0" required value={form.rate} onChange={set("rate")} />
              </Field>
            )}
            <Field label="GST Rate">
              <select value={form.taxRate} onChange={set("taxRate")}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
            </Field>
            <Field label="SAC" hint="Service code on the invoice">
              <input className="mono" value={form.sac} onChange={set("sac")} />
            </Field>
          </div>
          <div className="row-3">
            <Field label="Budget Hours">
              <input type="number" step="0.25" min="0" value={form.budgetHours} onChange={set("budgetHours")} />
            </Field>
            <Field label="Budget Amount (₹)">
              <input type="number" step="0.01" min="0" value={form.budgetAmount} onChange={set("budgetAmount")} />
            </Field>
            {id && (
              <Field label="Status">
                <select value={form.status} onChange={set("status")}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
            )}
          </div>
          <Field label="Description">
            <textarea rows={2} value={form.description} onChange={set("description")} />
          </Field>
        </div>

        <h4 className="section-title">Tasks</h4>
        <table className="table adj-table">
          <thead>
            <tr>
              <th>Task Name</th>
              <th>Description</th>
              {m === "task_hours" && <th className="num">Rate per Hour (₹)</th>}
              <th>Billable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.tasks.map((t, i) => (
              <tr key={i}>
                <td>
                  <input value={t.name} onChange={(e) => setTask(i, "name", e.target.value)} placeholder="e.g. Design" required={i === 0} />
                </td>
                <td>
                  <input value={t.description || ""} onChange={(e) => setTask(i, "description", e.target.value)} />
                </td>
                {m === "task_hours" && (
                  <td>
                    <input type="number" step="0.01" min="0" value={t.rate} onChange={(e) => setTask(i, "rate", e.target.value)} />
                  </td>
                )}
                <td>
                  <input type="checkbox" checked={t.billable !== false} onChange={(e) => setTask(i, "billable", e.target.checked)} />
                </td>
                <td>
                  {form.tasks.length > 1 && (
                    <button type="button" className="icon-btn" onClick={() => setForm({ ...form, tasks: form.tasks.filter((_, j) => j !== i) })}>
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, tasks: [...form.tasks, { name: "", description: "", rate: "", billable: true }] })}>
          <Icon name="plus" size={14} /> Add task
        </button>

        <h4 className="section-title">Users</h4>
        <table className="table adj-table">
          <thead>
            <tr>
              <th>User</th>
              {m === "staff_hours" && <th className="num">Rate per Hour (₹)</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {form.users.map((u, i) => (
              <tr key={i}>
                <td>
                  <select value={u.user} onChange={(e) => setUser(i, "user", e.target.value)}>
                    <option value="">Select a user</option>
                    {users.map((x) => (
                      <option key={x._id} value={x._id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </td>
                {m === "staff_hours" && (
                  <td>
                    <input type="number" step="0.01" min="0" value={u.rate} onChange={(e) => setUser(i, "rate", e.target.value)} />
                  </td>
                )}
                <td>
                  <button type="button" className="icon-btn" onClick={() => setForm({ ...form, users: form.users.filter((_, j) => j !== i) })}>
                    <Icon name="x" size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, users: [...form.users, { user: "", rate: "" }] })}>
          <Icon name="plus" size={14} /> Add user
        </button>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

export function ProjectView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [entries, setEntries] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = () => {
    api.get(`/projects/${id}`).then((r) => setP(r.data));
    api.get("/time-entries", { params: { project: id } }).then((r) => setEntries(r.data));
  };
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Spinner />;
  const s = p.summary;
  const stat = (label, value, sub) => (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
  const budgetPct = p.budgetHours ? Math.min(100, Math.round((s.loggedHours / p.budgetHours) * 100)) : null;
  const remove = async () => {
    try {
      await api.delete(`/projects/${id}`);
      toast("Project deleted");
      navigate("/projects");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <PageHeader title={p.name} subtitle={`${p.customerName} · ${methodName(p.billingMethod)}${p.status === "inactive" ? " · Inactive" : ""}`} back="/projects">
        <button className="btn" onClick={() => setLogOpen(true)}>
          <Icon name="plus" size={16} /> Log Time
        </button>
        <Link to={`/projects/${id}/edit`} className="btn">
          Edit
        </Link>
        <button className="btn btn-primary" onClick={() => setBillOpen(true)}>
          Invoice Project
        </button>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card">
        <div className="stats-row">
          {stat("Logged Hours", fmtHours(s.loggedHours), p.budgetHours ? `of ${p.budgetHours} budgeted` : "")}
          {stat("Billable Hours", fmtHours(s.billableHours))}
          {stat("Billed Hours", fmtHours(s.billedHours))}
          {stat("Unbilled Hours", fmtHours(s.unbilledHours))}
          {p.billingMethod === "fixed" ? stat("Project Fee", money(p.fixedAmount), `${money(s.fixedRemaining)} left to bill`) : stat("Unbilled Amount", money(s.unbilledAmount))}
          {stat("Invoiced", money(s.invoicedAmount), "before GST")}
          {p.billingMethod === "project_hours" && stat("Rate", `${money(p.rate)}/hr`)}
        </div>
        {budgetPct !== null && (
          <div className="budget">
            <div className="budget-bar">
              <div className={`budget-fill ${budgetPct >= 100 ? "over" : budgetPct >= 80 ? "warn" : ""}`} style={{ width: `${budgetPct}%` }} />
            </div>
            <span className="muted small">{budgetPct}% of budgeted hours used</span>
          </div>
        )}
        {p.description && <p className="muted">{p.description}</p>}
      </div>
      <div className="card flush">
        <h3 className="card-title pad">Timesheet</h3>
        <EntriesTable rows={entries} onChanged={load} hideProject />
      </div>
      <div className="grid-2">
        <div className="card flush">
          <h3 className="card-title pad">Tasks</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                {p.billingMethod === "task_hours" && <th className="num">Rate</th>}
                <th className="num">Logged</th>
              </tr>
            </thead>
            <tbody>
              {p.tasks.map((t) => (
                <tr key={t._id}>
                  <td>
                    {t.name}
                    {t.billable === false && <span className="muted small"> · non-billable</span>}
                  </td>
                  {p.billingMethod === "task_hours" && <td className="num">{money(t.rate)}/hr</td>}
                  <td className="num">{fmtHours(entries.filter((e) => e.task === t._id).reduce((a, e) => a + e.hours, 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card flush">
          <h3 className="card-title pad">Invoices</h3>
          <table className="table">
            <tbody>
              {s.invoices.map((i) => (
                <tr key={i._id}>
                  <td>{date(i.date)}</td>
                  <td>
                    <Link to={`/invoices/${i._id}`}>{i.invoiceNumber}</Link>
                  </td>
                  <td>
                    <span className={`status status-${i.status}`}>{i.status.replace("_", " ")}</span>
                  </td>
                  <td className="num">{money(i.total)}</td>
                </tr>
              ))}
              {!s.invoices.length && (
                <tr>
                  <td className="muted center">Not invoiced yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {logOpen && <LogTimeModal project={p} onClose={() => setLogOpen(false)} onSaved={() => (setLogOpen(false), load())} />}
      {billOpen && <InvoiceProjectModal project={p} onClose={() => setBillOpen(false)} />}
      <Confirm open={confirm} title="Delete project?" text="Projects with time or invoices can only be marked inactive." onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}

function InvoiceProjectModal({ project: p, onClose }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [groupBy, setGroupBy] = useState("task");
  const [amount, setAmount] = useState(p.summary.fixedRemaining || "");
  const [busy, setBusy] = useState(false);
  const fixed = p.billingMethod === "fixed";
  useEffect(() => {
    if (fixed) return;
    api.get(`/projects/${p._id}/unbilled`).then((r) => {
      setRows(r.data);
      setPicked(new Set(r.data.map((e) => e._id)));
    });
  }, [p._id, fixed]);
  const chosen = (rows || []).filter((e) => picked.has(e._id));
  const total = chosen.reduce((s, e) => s + e.amount, 0);
  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/projects/${p._id}/invoice`, fixed ? { amount: Number(amount) } : { entries: [...picked], groupBy });
      toast(`Draft invoice ${data.invoiceNumber} created`);
      navigate(`/invoices/${data._id}`);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      title={`Invoice ${p.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" disabled={busy || (fixed ? !(Number(amount) > 0) : !chosen.length)} onClick={create}>
            Create Draft Invoice
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {fixed ? (
        <div className="form-grid">
          <p className="muted">
            Project fee {money(p.fixedAmount)} · already invoiced {money(p.summary.invoicedAmount)} · left {money(p.summary.fixedRemaining)}
          </p>
          <Field label="Amount to bill now (₹, before GST)">
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      ) : !rows ? (
        <Spinner />
      ) : !rows.length ? (
        <p className="muted">There's no unbilled billable time on this project.</p>
      ) : (
        <>
          <div className="inline-add" style={{ marginBottom: 10 }}>
            <span className="muted small">Show on invoice as one line per</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 160 }}>
              <option value="task">Task</option>
              <option value="user">Person</option>
              <option value="project">Project (single line)</option>
              <option value="entry">Time entry</option>
            </select>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={picked.size === rows.length} onChange={(e) => setPicked(new Set(e.target.checked ? rows.map((r) => r._id) : []))} />
                </th>
                <th>Date</th>
                <th>Task</th>
                <th>User</th>
                <th>Notes</th>
                <th className="num">Hours</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e._id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.has(e._id)}
                      onChange={() => {
                        const n = new Set(picked);
                        n.has(e._id) ? n.delete(e._id) : n.add(e._id);
                        setPicked(n);
                      }}
                    />
                  </td>
                  <td>{date(e.date)}</td>
                  <td>{e.taskName}</td>
                  <td>{e.userName}</td>
                  <td className="muted">{e.notes}</td>
                  <td className="num">{fmtHours(e.hours)}</td>
                  <td className="num">{money(e.rate)}</td>
                  <td className="num">{money(e.amount)}</td>
                </tr>
              ))}
              <tr className="row-total">
                <td colSpan={5}>{chosen.length} selected</td>
                <td className="num">{fmtHours(chosen.reduce((s, e) => s + e.hours, 0))}</td>
                <td />
                <td className="num strong">{money(total)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/* ============================ Time entries ============================ */
export function LogTimeModal({ project, entry, onClose, onSaved }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState(project ? [project] : null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({
    project: entry?.project || project?._id || "",
    task: entry?.task || project?.tasks?.[0]?._id || "",
    user: entry?.user || user?._id,
    date: entry ? isoDate(entry.date) : isoDate(),
    duration: entry ? fmtHours(entry.hours) : "",
    notes: entry?.notes || "",
    billable: entry ? entry.billable : true,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!project) api.get("/projects", { params: { status: "active", summary: 0 } }).then((r) => setProjects(r.data));
    if (["admin", "accountant"].includes(user?.role)) api.get("/users").then((r) => setUsers(r.data.filter((u) => u.status === "active"))).catch(() => {});
  }, [project, user]);
  const p = (projects || []).find((x) => x._id === form.project);
  const tasks = p?.tasks || [];
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { ...form };
      if (entry) await api.put(`/time-entries/${entry._id}`, body);
      else await api.post("/time-entries", body);
      toast(entry ? "Time entry updated" : "Time logged");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={entry ? "Edit Time Entry" : "Log Time"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            Save
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form-grid">
        {!project && (
          <Field label="Project" required>
            <select
              value={form.project}
              onChange={(e) => {
                const np = projects.find((x) => x._id === e.target.value);
                setForm({ ...form, project: e.target.value, task: np?.tasks?.[0]?._id || "", billable: np?.tasks?.[0]?.billable !== false });
              }}
            >
              <option value="">Select a project</option>
              {(projects || []).map((x) => (
                <option key={x._id} value={x._id}>
                  {x.name} — {x.customerName}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Task" required>
          <select
            value={form.task}
            onChange={(e) => setForm({ ...form, task: e.target.value, billable: tasks.find((t) => t._id === e.target.value)?.billable !== false })}
          >
            {tasks.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row-2">
          <Field label="Date" required>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Time Spent" required hint="hh:mm or hours, e.g. 1:30 or 1.5">
            <input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="1:30" autoFocus />
          </Field>
        </div>
        {users.length > 1 && (
          <Field label="User">
            <select value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })}>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Notes">
          <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.billable} onChange={(e) => setForm({ ...form, billable: e.target.checked })} /> Billable
        </label>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

function EntriesTable({ rows, onChanged, hideProject }) {
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const total = rows.reduce((s, e) => s + e.hours, 0);
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            {!hideProject && <th>Project</th>}
            <th>Task</th>
            <th>User</th>
            <th>Notes</th>
            <th>Status</th>
            <th className="num">Hours</th>
            <th className="num">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e._id}>
              <td className="nowrap">{date(e.date)}</td>
              {!hideProject && (
                <td>
                  <Link to={`/projects/${e.project}`}>{e.projectName}</Link>
                  <div className="muted small">{e.customerName}</div>
                </td>
              )}
              <td>{e.taskName}</td>
              <td>{e.userName}</td>
              <td className="muted">{e.notes}</td>
              <td>
                <span className={`status status-${e.billed ? "paid" : e.billable ? "sent" : "draft"}`}>{e.billed ? "Invoiced" : e.billable ? "Unbilled" : "Non-billable"}</span>
              </td>
              <td className="num">{fmtHours(e.hours)}</td>
              <td className="num">{e.amount ? money(e.amount) : ""}</td>
              <td className="num nowrap">
                {!e.billed && (
                  <>
                    <button className="icon-btn" title="Edit" onClick={() => setEdit(e)}>
                      <Icon name="edit" size={15} />
                    </button>
                    <button className="icon-btn" title="Delete" onClick={() => setDel(e)}>
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={9} className="muted center">
                No time logged.
              </td>
            </tr>
          ) : (
            <tr className="row-total">
              <td colSpan={hideProject ? 5 : 6}>Total</td>
              <td className="num">{fmtHours(total)}</td>
              <td className="num">{money(rows.reduce((s, e) => s + e.amount, 0))}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {edit && <LogTimeModal entry={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), onChanged())} />}
      <Confirm
        open={!!del}
        title="Delete time entry?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/time-entries/${del._id}`);
            toast("Time entry deleted");
            onChanged();
          } catch (e) {
            toast(errMsg(e), "error");
          }
          setDel(null);
        }}
        onCancel={() => setDel(null)}
      />
    </>
  );
}

function Timer({ onStopped }) {
  const [t, setT] = useState(undefined);
  const [projects, setProjects] = useState([]);
  const [pick, setPick] = useState({ project: "", task: "", notes: "" });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    api.get("/time-entries/timer").then((r) => setT(r.data));
    api.get("/projects", { params: { status: "active", summary: 0 } }).then((r) => setProjects(r.data));
  }, []);
  useEffect(() => {
    if (!t) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [t]);
  if (t === undefined) return null;
  const p = projects.find((x) => x._id === pick.project);
  const run = async (fn, msg) => {
    try {
      const r = await fn();
      if (msg) toast(msg);
      return r;
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  if (t) {
    const secs = Math.floor((now - new Date(t.timerStartedAt).getTime()) / 1000);
    const hms = `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    return (
      <div className="card timer running">
        <span className="timer-dot" />
        <span className="timer-clock">{hms}</span>
        <span>
          <strong>{t.projectName}</strong> · {t.taskName} {t.notes && <span className="muted">— {t.notes}</span>}
        </span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={async () => (await run(() => api.post("/time-entries/timer/stop"), "Time logged")) && (setT(null), onStopped())}>
          Stop & Log
        </button>
        <button className="btn btn-ghost" onClick={async () => (await run(() => api.delete("/time-entries/timer"), "Timer discarded")) && setT(null)}>
          Discard
        </button>
      </div>
    );
  }
  return (
    <div className="card timer">
      <Icon name="clock" />
      <select value={pick.project} onChange={(e) => setPick({ ...pick, project: e.target.value, task: projects.find((x) => x._id === e.target.value)?.tasks?.[0]?._id || "" })}>
        <option value="">Project…</option>
        {projects.map((x) => (
          <option key={x._id} value={x._id}>
            {x.name}
          </option>
        ))}
      </select>
      <select value={pick.task} onChange={(e) => setPick({ ...pick, task: e.target.value })} disabled={!p}>
        {(p?.tasks || []).map((x) => (
          <option key={x._id} value={x._id}>
            {x.name}
          </option>
        ))}
      </select>
      <input placeholder="What are you working on?" value={pick.notes} onChange={(e) => setPick({ ...pick, notes: e.target.value })} />
      <button className="btn btn-primary" disabled={!pick.task} onClick={async () => {
        const r = await run(() => api.post("/time-entries/timer/start", pick));
        if (r) setT(r.data);
      }}>
        Start Timer
      </button>
    </div>
  );
}

export function Timesheet() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [projects, setProjects] = useState([]);
  const [range, setRange] = useState({ key: "this_month", ...periodRange("this_month") });
  const [f, setF] = useState({ project: "", status: "", mine: false });
  const [logOpen, setLogOpen] = useState(false);
  const load = () => {
    setRows(null);
    api
      .get("/time-entries", { params: { from: range.from, to: range.to, project: f.project || undefined, status: f.status || undefined, user: f.mine ? user._id : undefined } })
      .then((r) => setRows(r.data));
  };
  useEffect(() => {
    api.get("/projects", { params: { summary: 0 } }).then((r) => setProjects(r.data));
  }, []);
  useEffect(load, [range.from, range.to, f.project, f.status, f.mine]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Timesheet">
        <select className="select-inline" value={range.key} onChange={(e) => setRange({ key: e.target.value, ...periodRange(e.target.value) })}>
          {PERIODS.filter(([k]) => k !== "custom").map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select className="select-inline" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}>
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="select-inline" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">All</option>
          <option value="unbilled">Unbilled</option>
          <option value="billed">Invoiced</option>
          <option value="nonbillable">Non-billable</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> Only mine
        </label>
        <button className="btn btn-primary" onClick={() => setLogOpen(true)} disabled={!projects.length}>
          <Icon name="plus" size={16} /> Log Time
        </button>
      </PageHeader>
      {!projects.length ? (
        <Empty
          icon="doc"
          title="Create a project first"
          text="Time is logged against a project's tasks."
          action={
            <Link to="/projects/new" className="btn btn-primary">
              New Project
            </Link>
          }
        />
      ) : (
        <>
          <Timer onStopped={load} />
          <div className="card flush">{!rows ? <Spinner /> : <EntriesTable rows={rows} onChanged={load} />}</div>
        </>
      )}
      {logOpen && <LogTimeModal onClose={() => setLogOpen(false)} onSaved={() => (setLogOpen(false), load())} />}
    </>
  );
}
