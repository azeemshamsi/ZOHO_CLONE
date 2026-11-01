import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date } from "../lib/format";
import { PageHeader, Spinner, Field, Modal, Confirm, toast } from "../components/ui";
import { AuthShell } from "./Auth";
import Icon from "../components/Icon";

const LEVEL = { full: "✓ Full", view: "View", none: "—" };
const statusCls = { active: "paid", invited: "sent", inactive: "void" };

export function UsersPage() {
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(null); // {mode:'invite'} | {mode:'edit', user}
  const [link, setLink] = useState(null);
  const [del, setDel] = useState(null);
  const [modules, setModules] = useState([]);
  const [roleEdit, setRoleEdit] = useState(null);
  const load = () => api.get("/users").then((r) => setUsers(r.data));
  const loadRoles = () => api.get("/users/roles").then((r) => setRoles(r.data));
  useEffect(() => {
    load();
    loadRoles();
    api.get("/roles/modules").then((r) => setModules(r.data));
  }, []);
  if (!users) return <Spinner />;
  const roleLabel = (k) => roles.find((r) => r.key === k)?.label || k;

  const act = async (fn, msg) => {
    try {
      const r = await fn();
      if (msg) toast(msg);
      load();
      return r;
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const resend = async (u) => {
    const r = await act(() => api.post(`/users/${u._id}/resend`));
    if (r) setLink({ ...r.data, email: u.email });
  };

  return (
    <>
      <PageHeader title="Users & Roles" subtitle="Invite your team and choose what each person can see and do.">
        <button className="btn btn-primary" onClick={() => setModal({ mode: "invite" })}>
          <Icon name="plus" size={16} /> Invite User
        </button>
      </PageHeader>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id}>
                <td className="strong">
                  {u.name} {u.you && <span className="muted small">(you)</span>}
                </td>
                <td>{u.email}</td>
                <td>{roleLabel(u.role)}</td>
                <td>
                  <span className={`status status-${statusCls[u.status]}`}>{u.status === "invited" ? "Invited" : u.status === "active" ? "Active" : "Inactive"}</span>
                </td>
                <td className="muted">{u.lastLogin ? date(u.lastLogin) : "—"}</td>
                <td className="num nowrap">
                  {u.status === "invited" && (
                    <button className="btn btn-sm" onClick={() => resend(u)}>
                      Resend Invite
                    </button>
                  )}{" "}
                  <button className="btn btn-sm" onClick={() => setModal({ mode: "edit", user: u })}>
                    Edit
                  </button>{" "}
                  {!u.you && u.status !== "invited" && (
                    <button className="btn btn-sm" onClick={() => act(() => api.put(`/users/${u._id}`, { status: u.status === "active" ? "inactive" : "active" }), u.status === "active" ? "User deactivated" : "User reactivated")}>
                      {u.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                  )}{" "}
                  {!u.you && (
                    <button className="icon-btn" title="Remove" onClick={() => setDel(u)}>
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card flush">
        <div className="card-head" style={{ padding: "16px 16px 0" }}>
          <h3 className="card-title" style={{ padding: 0 }}>
            Roles — what each can do
          </h3>
          <button className="btn btn-sm btn-primary" onClick={() => setRoleEdit({ name: "", desc: "", home: "", perms: Object.fromEntries(modules.map((m) => [m.key, "none"])) })}>
            <Icon name="plus" size={14} /> New Role
          </button>
        </div>
        <p className="muted small" style={{ padding: "4px 16px 0" }}>
          Make a role for each job, e.g. a returns desk that can only scan returned parcels. People with that role see nothing else in the app.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="table perm-table">
            <thead>
              <tr>
                <th>Module</th>
                {roles.map((r) => (
                  <th key={r.key}>
                    {r.builtIn ? (
                      r.label
                    ) : (
                      <button className="link-btn" onClick={() => setRoleEdit({ _id: r._id, name: r.label, desc: r.desc, home: r.home || "", perms: { ...Object.fromEntries(modules.map((m) => [m.key, "none"])), ...r.perms } })}>
                        {r.label} ✎
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <tr key={m.key}>
                  <td title={m.desc}>{m.label}</td>
                  {roles.map((r) => (
                    <td key={r.key} className={(r.perms[m.key] || "none") === "none" ? "muted" : ""}>
                      {LEVEL[r.perms[m.key] || "none"]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {roleEdit && (
        <RoleModal
          role={roleEdit}
          modules={modules}
          onClose={() => setRoleEdit(null)}
          onSaved={() => {
            setRoleEdit(null);
            loadRoles();
          }}
        />
      )}

      {modal && (
        <UserModal
          roles={roles}
          user={modal.user}
          onClose={() => setModal(null)}
          onSaved={(r) => {
            setModal(null);
            load();
            if (r?.link) setLink(r);
          }}
        />
      )}
      <Modal open={!!link} title="Invitation ready" onClose={() => setLink(null)} footer={<button className="btn btn-primary" onClick={() => setLink(null)}>Done</button>}>
        {link && (
          <>
            <p>{link.emailed ? `We emailed the invitation to ${link.email || link.user?.email}. You can also share this link:` : "Email isn't set up on this server, so send this link to the person yourself (WhatsApp, email…). It works for 7 days."}</p>
            <div className="inline-add">
              <input readOnly value={link.link} onFocus={(e) => e.target.select()} />
              <button
                className="btn"
                onClick={() => {
                  navigator.clipboard?.writeText(link.link);
                  toast("Link copied");
                }}
              >
                Copy
              </button>
            </div>
          </>
        )}
      </Modal>
      <Confirm open={!!del} title={`Remove ${del?.name}?`} text="They will no longer be able to sign in. Their past work stays." confirmLabel="Remove" onConfirm={() => act(() => api.delete(`/users/${del._id}`), "User removed").then(() => setDel(null))} onCancel={() => setDel(null)} />
    </>
  );
}

function UserModal({ roles, user, onClose, onSaved }) {
  const [form, setForm] = useState({ name: user?.name || "", email: user?.email || "", role: user?.role || "staff" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (user) {
        await api.put(`/users/${user._id}`, { name: form.name, role: form.role });
        toast("User updated");
        onSaved();
      } else {
        const { data } = await api.post("/users", form);
        if (data.added) {
          toast(data.message);
          onSaved();
        } else {
          toast("Invitation created");
          onSaved({ ...data, email: form.email });
        }
      }
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={user ? `Edit ${user.name}` : "Invite User"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {user ? "Save" : "Send Invite"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" required>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Email" required>
          <input type="email" value={form.email} disabled={!!user} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Role" required>
          <div className="role-grid">
            {roles.map((r) => (
              <label key={r.key} className={`role-card ${form.role === r.key ? "on" : ""}`}>
                <input type="radio" checked={form.role === r.key} onChange={() => setForm({ ...form, role: r.key })} />
                <span>
                  <strong>{r.label}</strong>
                  <div className="muted small">{r.desc}</div>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

const HOMES = [
  ["", "Dashboard (or first page they can open)"],
  ["/returns-scan", "Scan Returns"],
  ["/shopify-orders", "Store orders"],
  ["/inventory", "Inventory"],
  ["/invoices", "Invoices"],
  ["/bills", "Bills"],
  ["/reports", "Reports"],
];

function RoleModal({ role, modules, onClose, onSaved }) {
  const [f, setF] = useState(role);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, desc: f.desc || "", home: f.home || "", perms: f.perms };
      if (f._id) await api.put(`/roles/${f._id}`, body);
      else await api.post("/roles", body);
      toast("Role saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api.delete(`/roles/${f._id}`);
      toast("Role deleted");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const setAll = (lvl) => setF({ ...f, perms: Object.fromEntries(modules.map((m) => [m.key, lvl])) });
  return (
    <Modal
      open
      wide
      title={f._id ? `Edit role: ${role.name}` : "New role"}
      onClose={onClose}
      footer={
        <>
          {f._id && (
            <button className="btn btn-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>
            Save Role
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-2">
          <Field label="Role name" required>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Returns Desk" autoFocus />
          </Field>
          <Field label="Opens on">
            <select value={f.home} onChange={(e) => setF({ ...f, home: e.target.value })}>
              {HOMES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} />
        </Field>
        <div className="row-actions">
          <span className="muted small">Set all:</span>
          {["none", "view", "full"].map((l) => (
            <button key={l} type="button" className="btn btn-sm" onClick={() => setAll(l)}>
              {LEVEL[l]}
            </button>
          ))}
        </div>
        <table className="table compact perm-edit">
          <tbody>
            {modules.map((m) => (
              <tr key={m.key}>
                <td>
                  <strong>{m.label}</strong>
                  <div className="muted small">{m.desc}</div>
                </td>
                <td className="seg">
                  {["none", "view", "full"].map((l) => (
                    <label key={l} className={`seg-btn ${f.perms[m.key] === l ? "on" : ""}`}>
                      <input type="radio" checked={f.perms[m.key] === l} onChange={() => setF({ ...f, perms: { ...f.perms, [m.key]: l } })} />
                      {l === "none" ? "No access" : l === "view" ? "View" : "Full"}
                    </label>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function AcceptInvite() {
  const { id, token } = useParams();
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get(`/auth/invite/${id}/${token}`)
      .then((r) => {
        setInfo(r.data);
        setForm((f) => ({ ...f, name: r.data.name }));
      })
      .catch((e) => setError(errMsg(e)));
  }, [id, token]);
  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("Passwords don't match");
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(`/auth/invite/${id}/${token}`, { name: form.name, password: form.password });
      signIn(data);
      navigate("/");
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  return (
    <AuthShell title={info ? `Join ${info.organization}` : "Accept invitation"} subtitle={info ? `You've been invited as ${info.role}. Set a password for ${info.email}.` : ""}>
      {!info ? (
        error ? (
          <>
            <div className="alert alert-error">{error}</div>
            <p>
              <Link to="/login">Go to sign in</Link>
            </p>
          </>
        ) : (
          <Spinner />
        )
      ) : (
        <form onSubmit={submit} className="form-grid">
          <Field label="Your Name" required>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Password" required hint="At least 8 characters, with letters and numbers">
            <input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Confirm Password" required>
            <input type="password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>
            Accept & Sign In
          </button>
        </form>
      )}
    </AuthShell>
  );
}
