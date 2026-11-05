import { useEffect, useMemo, useState } from "react";
import api, { errMsg } from "../lib/api";
import { STATES, stateName } from "../lib/constants";
import { money, date, isoDate } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, Modal, Confirm, SearchBox, toast } from "../components/ui";
import Icon from "../components/Icon";

// OrdexaGo superadmin: the businesses that subscribe to OrdexaGo, their plans, validity and payments.

const PERIODS = [
  ["monthly", "Monthly", 1],
  ["quarterly", "Quarterly", 3],
  ["half_yearly", "Half-yearly", 6],
  ["yearly", "Yearly", 12],
];
const periodName = (p) => (PERIODS.find((x) => x[0] === p) || [])[1] || p;
const periodMonths = (p) => (PERIODS.find((x) => x[0] === p) || [])[2] || 12;
const STATE = {
  unlimited: ["Owner", "status-accepted"],
  active: ["Active", "status-paid"],
  grace: ["Grace", "status-partially_paid"],
  expired: ["Expired", "status-overdue"],
  suspended: ["Suspended", "status-declined"],
};
const lim = (n) => (n === null || n === undefined || n === "" ? "∞" : n);
const today = () => isoDate(new Date());
const addMonths = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
const minusDay = (iso) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
// Next validity for one more period: continue from the current end date when still valid or within the grace
// period (paying late doesn't add days), else start from today.
const nextValidTill = (cur, period, graceDays = 0) => {
  const n = periodMonths(period);
  const c = cur ? isoDate(cur) : "";
  const since = new Date(`${today()}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 1 - Number(graceDays || 0));
  return c && c >= since.toISOString().slice(0, 10) ? addMonths(c, n) : minusDay(addMonths(today(), n));
};

function StateBadge({ s }) {
  const [label, cls] = STATE[s.state] || [s.state, ""];
  return (
    <span>
      <span className={`status ${cls}`}>{label}</span>
      {s.state === "active" && s.daysLeft !== undefined && s.daysLeft <= 15 && <span className="small muted"> {s.daysLeft}d left</span>}
      {s.state === "grace" && <span className="small muted"> {s.graceLeft}d to block</span>}
    </span>
  );
}

export default function Superadmin() {
  const [tab, setTab] = useState("subscribers");
  const [plans, setPlans] = useState(null);
  const loadPlans = () => api.get("/superadmin/plans").then((r) => setPlans(r.data));
  useEffect(() => {
    loadPlans().catch((e) => toast(errMsg(e), "error"));
  }, []);
  return (
    <>
      <PageHeader title="Superadmin" subtitle="Businesses that use OrdexaGo, their plans and subscriptions" />
      <div className="tabs">
        <button className={`tab ${tab === "subscribers" ? "active" : ""}`} onClick={() => setTab("subscribers")}>
          Subscribers
        </button>
        <button className={`tab ${tab === "plans" ? "active" : ""}`} onClick={() => setTab("plans")}>
          Plans
        </button>
      </div>
      {!plans ? <Spinner /> : tab === "subscribers" ? <Subscribers plans={plans} /> : <Plans plans={plans} reload={loadPlans} />}
    </>
  );
}

/* ======================= Subscribers ======================= */
function Subscribers({ plans }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState(null); // {} new, or subscriber to edit
  const [open, setOpen] = useState(null); // subscriber id
  const [invite, setInvite] = useState(null); // {link, emailed, email}
  const load = () =>
    api
      .get("/superadmin/subscribers")
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, []);
  const counts = useMemo(() => {
    const c = {};
    for (const s of list || []) c[s.state] = (c[s.state] || 0) + 1;
    return c;
  }, [list]);
  if (!list) return <Spinner />;
  const t = q.trim().toLowerCase();
  const rows = list.filter((s) => (!filter || s.state === filter) && (!t || [s.name, s.contactName, s.email, s.phone, s.plan?.name].some((x) => String(x || "").toLowerCase().includes(t))));
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search business, contact, email, phone" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">All ({list.length})</option>
          {["active", "grace", "expired", "suspended", "unlimited"].map((k) => (
            <option key={k} value={k}>
              {STATE[k][0]} ({counts[k] || 0})
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setForm({})}>
          <Icon name="plus" size={16} /> New subscriber
        </button>
      </div>
      {!rows.length ? (
        <Empty title={list.length ? "No subscribers match" : "No subscribers yet"} text="Add a business: OrdexaGo creates its company and admin login and emails them a link to set their password." />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table table-click">
            <thead>
              <tr>
                <th>Business</th>
                <th>Plan</th>
                <th className="num">Companies</th>
                <th className="num">Users</th>
                <th className="num">Stores</th>
                <th>Valid till</th>
                <th>Status</th>
                <th className="num">Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s._id} onClick={() => setOpen(s._id)}>
                  <td>
                    <div className="strong">{s.name}</div>
                    <div className="small muted">{[s.contactName, s.email, s.phone].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>{s.owner ? "—" : s.plan?.name || <span className="muted">No plan</span>}</td>
                  <td className="num">
                    {s.usage.companies}
                    {!s.owner && s.plan && <span className="muted"> / {lim(s.plan.maxCompanies)}</span>}
                  </td>
                  <td className="num">
                    {s.usage.users}
                    {!s.owner && s.plan && <span className="muted"> / {lim(s.plan.maxUsers)}</span>}
                  </td>
                  <td className="num">
                    {s.usage.shopifyStores}
                    {!s.owner && s.plan && <span className="muted"> / {lim(s.plan.maxShopifyStores)}</span>}
                  </td>
                  <td>{s.owner ? "Never expires" : s.validTill ? date(s.validTill) : "—"}</td>
                  <td>
                    <StateBadge s={s} />
                  </td>
                  <td className="num">{s.paid ? money(s.paid) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <SubscriberForm
          sub={form}
          plans={plans}
          onClose={() => setForm(null)}
          onSaved={(r) => {
            setForm(null);
            load();
            if (r?.link) setInvite({ ...r, email: r.subscriber.email });
          }}
        />
      )}
      {open && (
        <SubscriberDetail
          id={open}
          plans={plans}
          onClose={() => setOpen(null)}
          onEdit={(s) => {
            setOpen(null);
            setForm(s);
          }}
          onChanged={load}
          onInvite={setInvite}
        />
      )}
      {invite && <InviteResult invite={invite} onClose={() => setInvite(null)} />}
    </>
  );
}

function InviteResult({ invite, onClose }) {
  const copy = () => navigator.clipboard?.writeText(invite.link).then(() => toast("Link copied"));
  return (
    <Modal
      open
      title="Login link"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p style={{ marginTop: 0 }}>
        {invite.emailed ? (
          <>
            We emailed <strong>{invite.email}</strong> a link to set their password.
          </>
        ) : (
          <>
            The email to <strong>{invite.email}</strong> couldn't be sent. Share this link with them (WhatsApp / email) to set their password:
          </>
        )}
      </p>
      <div style={{ display: "flex", gap: 6 }}>
        <input readOnly value={invite.link} onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={copy}>
          Copy
        </button>
      </div>
      <p className="small muted">The link works for 14 days. After setting a password they log in at ordexago.com with their email.</p>
    </Modal>
  );
}

function SubscriberForm({ sub, plans, onClose, onSaved }) {
  const isNew = !sub._id;
  const firstPlan = plans.find((p) => p.active !== false);
  const [f, setF] = useState(() =>
    isNew
      ? { name: "", contactName: "", email: "", phone: "", companyName: "", state: "09", gstin: "", plan: firstPlan?._id || "", validTill: firstPlan ? nextValidTill("", firstPlan.period) : "", graceDays: 7, notes: "" }
      : { name: sub.name, contactName: sub.contactName || "", email: sub.email || "", phone: sub.phone || "", plan: sub.plan?._id || sub.plan || "", validTill: sub.validTill ? isoDate(sub.validTill) : "", graceDays: sub.graceDays ?? 7, notes: sub.notes || "" }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickPlan = (id) => {
    const p = plans.find((x) => x._id === id);
    setF({ ...f, plan: id, ...(isNew && p ? { validTill: nextValidTill("", p.period) } : {}) });
  };
  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...f, graceDays: Number(f.graceDays || 0), validTill: f.validTill || null, plan: f.plan || null };
      if (sub.owner) ["plan", "validTill", "graceDays"].forEach((k) => delete body[k]);
      const { data } = isNew ? await api.post("/superadmin/subscribers", body) : await api.put(`/superadmin/subscribers/${sub._id}`, body);
      toast(isNew ? `${f.name} added` : "Saved");
      onSaved(data);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      title={isNew ? "New subscriber" : `Edit ${sub.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : isNew ? "Create & send login" : "Save"}
          </button>
        </>
      }
    >
      <form onSubmit={save} className="form-grid">
        <div className="row-2">
          <Field label="Business name" required>
            <input autoFocus value={f.name} onChange={set("name")} />
          </Field>
          <Field label="Contact person" required={isNew} hint={isNew ? "Becomes the admin user" : ""}>
            <input value={f.contactName} onChange={set("contactName")} />
          </Field>
        </div>
        <div className="row-2">
          <Field label="Email" required hint={isNew ? "Their OrdexaGo login" : "Contact email (logins are under Users)"}>
            <input type="email" value={f.email} onChange={set("email")} />
          </Field>
          <Field label="Phone">
            <input value={f.phone} onChange={set("phone")} />
          </Field>
        </div>
        {isNew && (
          <div className="row-3">
            <Field label="First company name" required>
              <input value={f.companyName} onChange={set("companyName")} />
            </Field>
            <Field label="State" required>
              <select value={f.state} onChange={set("state")}>
                {STATES.map(([c, s]) => (
                  <option key={c} value={c}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="GSTIN">
              <input value={f.gstin} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase(), ...(e.target.value.length >= 2 && /^\d\d/.test(e.target.value) ? { state: e.target.value.slice(0, 2) } : {}) })} />
            </Field>
          </div>
        )}
        {!sub.owner && (
          <div className="row-3">
            <Field label="Plan">
              <select value={f.plan} onChange={(e) => pickPlan(e.target.value)}>
                <option value="">No plan (no limits)</option>
                {plans
                  .filter((p) => p.active !== false || p._id === f.plan)
                  .map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name} — {money(p.price)} {periodName(p.period).toLowerCase()}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Valid till" hint="Access to the end of this day">
              <input type="date" value={f.validTill} onChange={set("validTill")} />
            </Field>
            <Field label="Grace days" hint="Access with a warning after expiry, then blocked">
              <input type="number" min="0" value={f.graceDays} onChange={set("graceDays")} />
            </Field>
          </div>
        )}
        <Field label="Notes">
          <textarea rows={2} value={f.notes} onChange={set("notes")} />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </form>
    </Modal>
  );
}

function SubscriberDetail({ id, plans, onClose, onEdit, onChanged, onInvite }) {
  const [s, setS] = useState(null);
  const [pay, setPay] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const load = () =>
    api
      .get(`/superadmin/subscribers/${id}`)
      .then((r) => setS(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, [id]);
  const changed = () => {
    load();
    onChanged();
  };
  const setStatus = async (status) => {
    try {
      await api.put(`/superadmin/subscribers/${id}`, { status });
      toast(status === "suspended" ? "Suspended: they can't log in now" : "Reactivated");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setConfirm(null);
  };
  const resend = async () => {
    try {
      const { data } = await api.post(`/superadmin/subscribers/${id}/resend-invite`);
      const i = data.invites[0];
      onInvite({ ...i });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const delPayment = async (pid) => {
    try {
      await api.delete(`/superadmin/subscribers/${id}/payments/${pid}`);
      toast("Payment removed (valid till unchanged — edit it if needed)");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setConfirm(null);
  };
  return (
    <Modal open wide title={s ? s.name : "Subscriber"} onClose={onClose}>
      {!s ? (
        <Spinner />
      ) : (
        <div className="form-grid">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <StateBadge s={s} />
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => onEdit(s)}>
              <Icon name="edit" size={14} /> Edit
            </button>
            {!s.owner && (
              <button className="btn btn-sm btn-primary" onClick={() => setPay(true)}>
                Record payment / renew
              </button>
            )}
            {s.users.some((u) => u.status === "invited") && (
              <button className="btn btn-sm" onClick={resend}>
                Resend login link
              </button>
            )}
            {!s.owner &&
              (s.status === "suspended" ? (
                <button className="btn btn-sm" onClick={() => setStatus("active")}>
                  Reactivate
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => setConfirm({ kind: "suspend" })}>
                  Suspend
                </button>
              ))}
          </div>
          <dl className="details">
            <dt>Contact</dt>
            <dd>{[s.contactName, s.email, s.phone].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>Plan</dt>
            <dd>
              {s.owner ? "Owner account — no limits, never expires" : s.plan ? `${s.plan.name} (${money(s.plan.price)} ${periodName(s.plan.period).toLowerCase()}) — up to ${lim(s.plan.maxCompanies)} companies, ${lim(s.plan.maxUsers)} users, ${lim(s.plan.maxShopifyStores)} Shopify stores` : "No plan (no limits)"}
            </dd>
            {!s.owner && (
              <>
                <dt>Valid till</dt>
                <dd>
                  {s.validTill ? date(s.validTill) : "No end date"} · {s.graceDays} grace day{s.graceDays === 1 ? "" : "s"}
                </dd>
              </>
            )}
            {s.notes && (
              <>
                <dt>Notes</dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>{s.notes}</dd>
              </>
            )}
          </dl>

          <h4 style={{ margin: "8px 0 0" }}>Companies ({s.companies.length})</h4>
          <table className="table">
            <tbody>
              {s.companies.map((c) => (
                <tr key={c._id}>
                  <td>{c.name}</td>
                  <td className="small muted">{[c.gstin, stateName(c.state)].filter(Boolean).join(" · ")}</td>
                  <td className="small muted">Created {date(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={{ margin: "8px 0 0" }}>Users ({s.users.length})</h4>
          <table className="table">
            <tbody>
              {s.users.map((u) => (
                <tr key={u._id}>
                  <td>
                    {u.name}
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td className="small">{u.companies.map((c) => `${c.name} (${c.role.startsWith("custom:") ? "custom role" : c.role}${c.status !== "active" ? `, ${c.status}` : ""})`).join(", ")}</td>
                  <td className="small muted">{u.status === "invited" ? "Hasn't set a password yet" : u.lastLogin ? `Last login ${date(u.lastLogin)}` : "Never logged in"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {!s.owner && (
            <>
              <h4 style={{ margin: "8px 0 0" }}>Payments ({money(s.paid)})</h4>
              {!s.payments.length ? (
                <p className="muted small">No payments recorded.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="num">Amount</th>
                      <th>Reference</th>
                      <th>Extended to</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...s.payments].reverse().map((p) => (
                      <tr key={p._id}>
                        <td>{date(p.date)}</td>
                        <td className="num">{money(p.amount)}</td>
                        <td>
                          {p.reference}
                          {p.note && <div className="small muted">{p.note}</div>}
                        </td>
                        <td>{p.validTill ? date(p.validTill) : "—"}</td>
                        <td className="num">
                          <button className="icon-btn" title="Remove" onClick={() => setConfirm({ kind: "payment", id: p._id })}>
                            <Icon name="trash" size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
      {pay && s && (
        <PaymentForm
          s={s}
          onClose={() => setPay(false)}
          onSaved={() => {
            setPay(false);
            changed();
          }}
        />
      )}
      <Confirm
        open={confirm?.kind === "suspend"}
        title={`Suspend ${s?.name}?`}
        text="All their users are logged out and can't log in until you reactivate them. Their data is kept."
        confirmLabel="Suspend"
        onConfirm={() => setStatus("suspended")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm open={confirm?.kind === "payment"} title="Remove this payment?" text="The valid-till date stays as it is; edit the subscriber to change it." confirmLabel="Remove" onConfirm={() => delPayment(confirm.id)} onCancel={() => setConfirm(null)} />
    </Modal>
  );
}

function PaymentForm({ s, onClose, onSaved }) {
  const [f, setF] = useState({ date: today(), amount: s.plan?.price || "", reference: "", note: "", validTill: nextValidTill(s.validTill, s.plan?.period || "yearly", s.graceDays) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/superadmin/subscribers/${s._id}/payments`, { ...f, amount: Number(f.amount || 0) });
      toast(`Payment recorded. ${s.name} is valid till ${date(f.validTill)}.`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`Payment from ${s.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !f.validTill} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-2">
          <Field label="Date received" required>
            <input type="date" value={f.date} onChange={set("date")} />
          </Field>
          <Field label="Amount (₹)" required>
            <input type="number" min="0" step="0.01" value={f.amount} onChange={set("amount")} />
          </Field>
        </div>
        <div className="row-2">
          <Field label="Reference" hint="UPI / bank ref, invoice no.">
            <input value={f.reference} onChange={set("reference")} />
          </Field>
          <Field label="Valid till" required hint={s.validTill ? `Now ${date(s.validTill)}` : "Not set yet"}>
            <input type="date" value={f.validTill} onChange={set("validTill")} />
          </Field>
        </div>
        <Field label="Note">
          <input value={f.note} onChange={set("note")} />
        </Field>
        {s.status === "suspended" && <p className="small muted" style={{ margin: 0 }}>Saving also reactivates this suspended account.</p>}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

/* ======================= Plans ======================= */
function Plans({ plans, reload }) {
  const [form, setForm] = useState(null);
  const [del, setDel] = useState(null);
  const remove = async () => {
    try {
      await api.delete(`/superadmin/plans/${del._id}`);
      toast("Plan deleted");
      reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setDel(null);
  };
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={() => setForm({})}>
          <Icon name="plus" size={16} /> New plan
        </button>
      </div>
      {!plans.length ? (
        <Empty title="No plans yet" text="Create plans with a price and limits (companies, users, Shopify stores), then put each subscriber on one." />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table table-click">
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Price</th>
                <th>Billing</th>
                <th className="num">Companies</th>
                <th className="num">Users</th>
                <th className="num">Shopify stores</th>
                <th className="num">Subscribers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p._id} onClick={() => setForm(p)}>
                  <td>
                    <span className="strong">{p.name}</span> {p.active === false && <span className="status status-cancelled">Inactive</span>}
                    {p.description && <div className="small muted">{p.description}</div>}
                  </td>
                  <td className="num">{money(p.price)}</td>
                  <td>{periodName(p.period)}</td>
                  <td className="num">{lim(p.maxCompanies)}</td>
                  <td className="num">{lim(p.maxUsers)}</td>
                  <td className="num">{lim(p.maxShopifyStores)}</td>
                  <td className="num">{p.subscribers}</td>
                  <td className="num">
                    <button
                      className="icon-btn"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDel(p);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <PlanForm
          plan={form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            reload();
          }}
        />
      )}
      <Confirm open={!!del} title={`Delete plan ${del?.name}?`} text="Only possible when no subscriber is on it. To stop offering a plan, mark it inactive instead." onConfirm={remove} onCancel={() => setDel(null)} />
    </>
  );
}

function PlanForm({ plan, onClose, onSaved }) {
  const isNew = !plan._id;
  const v = (n) => (n === null || n === undefined ? "" : String(n));
  const [f, setF] = useState({ name: plan.name || "", description: plan.description || "", price: v(plan.price), period: plan.period || "yearly", maxCompanies: v(plan.maxCompanies), maxUsers: v(plan.maxUsers), maxShopifyStores: v(plan.maxShopifyStores), active: plan.active !== false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (x) => (x === "" ? null : Number(x));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { ...f, price: Number(f.price || 0), maxCompanies: num(f.maxCompanies), maxUsers: num(f.maxUsers), maxShopifyStores: num(f.maxShopifyStores) };
      if (isNew) await api.post("/superadmin/plans", body);
      else await api.put(`/superadmin/plans/${plan._id}`, body);
      toast(isNew ? "Plan created" : "Plan saved");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={isNew ? "New plan" : `Edit ${plan.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-2">
          <Field label="Plan name" required>
            <input autoFocus value={f.name} onChange={set("name")} placeholder="e.g. Basic, Business, Pro" />
          </Field>
          <Field label="Active" hint="Inactive plans can't be chosen for new subscribers">
            <select value={f.active ? "1" : "0"} onChange={(e) => setF({ ...f, active: e.target.value === "1" })}>
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </select>
          </Field>
        </div>
        <div className="row-2">
          <Field label="Price (₹)">
            <input type="number" min="0" step="0.01" value={f.price} onChange={set("price")} />
          </Field>
          <Field label="Billing period">
            <select value={f.period} onChange={set("period")}>
              {PERIODS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row-3">
          <Field label="Max companies" hint="Blank = unlimited">
            <input type="number" min="0" value={f.maxCompanies} onChange={set("maxCompanies")} />
          </Field>
          <Field label="Max users" hint="Blank = unlimited">
            <input type="number" min="0" value={f.maxUsers} onChange={set("maxUsers")} />
          </Field>
          <Field label="Max Shopify stores" hint="Blank = unlimited">
            <input type="number" min="0" value={f.maxShopifyStores} onChange={set("maxShopifyStores")} />
          </Field>
        </div>
        <Field label="Description">
          <input value={f.description} onChange={set("description")} />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}
