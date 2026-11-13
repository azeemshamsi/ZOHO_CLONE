import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date } from "../lib/format";
import {
  PageHeader,
  Spinner,
  Field,
  Modal,
  Confirm,
  toast,
} from "../components/ui";
import { AuthShell, SignInSteps, PASSWORD_HINT } from "./Auth";
import Icon from "../components/Icon";

const LEVEL = { full: "✓ Full", view: "View", none: "—" };
const statusCls = { active: "paid", invited: "sent", inactive: "void" };

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(null); // {mode:'invite'} | {mode:'edit', user}
  const [link, setLink] = useState(null);
  const [del, setDel] = useState(null);
  const [modules, setModules] = useState([]);
  const [roleEdit, setRoleEdit] = useState(null);
  const load = () => api.get("/users").then((r) => setUsers(r.data));
  const [deletedRoles, setDeletedRoles] = useState([]);
  const loadRoles = () => {
    api
      .get("/roles/builtin/deleted")
      .then((r) => setDeletedRoles(r.data))
      .catch(() => setDeletedRoles([]));
    return api.get("/users/roles").then((r) => setRoles(r.data));
  };
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
      <PageHeader
        title="Users & Roles"
        subtitle="Invite your team and choose what each person can see and do."
      >
        <button
          className="btn btn-primary"
          onClick={() => setModal({ mode: "invite" })}
        >
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
                  {u.twoFactor && (
                    <span className="muted small" title="Two-step login is on">
                      {" "}
                      · 2-step
                    </span>
                  )}
                </td>
                <td>{u.email}</td>
                <td>{(u.roles || [u.role]).map(roleLabel).join(" + ")}</td>
                <td>
                  <span className={`status status-${statusCls[u.status]}`}>
                    {u.status === "invited"
                      ? "Invited"
                      : u.status === "active"
                        ? "Active"
                        : "Inactive"}
                  </span>
                </td>
                <td className="muted">
                  {u.lastLogin ? date(u.lastLogin) : "—"}
                </td>
                <td className="num nowrap">
                  {u.status === "invited" && (
                    <button className="btn btn-sm" onClick={() => resend(u)}>
                      Resend Invite
                    </button>
                  )}{" "}
                  <button
                    className="btn btn-sm"
                    onClick={() => setModal({ mode: "edit", user: u })}
                  >
                    Edit
                  </button>{" "}
                  {u.twoFactor && (me?.role === "admin" || me?.superadmin) && (
                    <button
                      className="btn btn-sm"
                      title="For a lost phone: they set up two-step login again at their next sign-in"
                      onClick={() =>
                        window.confirm(
                          `Reset two-step login for ${u.name}? They'll be signed out and set it up again at their next sign-in.`,
                        ) &&
                        act(
                          () => api.post(`/users/${u._id}/reset-2fa`),
                          "Two-step login reset",
                        )
                      }
                    >
                      Reset 2-step
                    </button>
                  )}{" "}
                  {!u.you && u.status !== "invited" && (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        act(
                          () =>
                            api.put(`/users/${u._id}`, {
                              status:
                                u.status === "active" ? "inactive" : "active",
                            }),
                          u.status === "active"
                            ? "User deactivated"
                            : "User reactivated",
                        )
                      }
                    >
                      {u.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                  )}{" "}
                  {!u.you && (
                    <button
                      className="icon-btn"
                      title="Remove"
                      onClick={() => setDel(u)}
                    >
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
          <button
            className="btn btn-sm btn-primary"
            onClick={() =>
              setRoleEdit({
                name: "",
                desc: "",
                home: "",
                perms: Object.fromEntries(modules.map((m) => [m.key, "none"])),
              })
            }
          >
            <Icon name="plus" size={14} /> New Role
          </button>
        </div>
        <p className="muted small" style={{ padding: "4px 16px 0" }}>
          Make a role for each job, e.g. a returns desk that can only scan
          returned parcels. People with that role see nothing else in the app.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="table perm-table">
            <thead>
              <tr>
                <th>Module</th>
                {roles.map((r) => (
                  <th key={r.key}>
                    {r.locked ? (
                      r.label
                    ) : (
                      <button
                        className="link-btn"
                        title={
                          r.builtIn
                            ? "Built-in role — edit or delete it for this company"
                            : ""
                        }
                        onClick={() =>
                          setRoleEdit({
                            _id: r._id,
                            builtin: r.builtIn ? r.key : "",
                            edited: !!r.edited,
                            name: r.label,
                            desc: r.desc,
                            home: r.home || "",
                            perms: {
                              ...Object.fromEntries(
                                modules.map((m) => [m.key, "none"]),
                              ),
                              ...r.perms,
                            },
                          })
                        }
                      >
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
                    <td
                      key={r.key}
                      className={
                        (r.perms[m.key] || "none") === "none" &&
                        !pageOverrides(r.perms, m).length
                          ? "muted"
                          : ""
                      }
                    >
                      {LEVEL[r.perms[m.key] || "none"]}
                      {pageOverrides(r.perms, m).length > 0 && (
                        <div className="muted small">
                          {pageOverrides(r.perms, m)
                            .map((f) => `${f.label}: ${LEVEL[r.perms[f.key]]}`)
                            .join(", ")}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {deletedRoles.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Deleted built-in roles:{" "}
          {deletedRoles.map((r, i) => (
            <span key={r.key}>
              {i > 0 && ", "}
              {r.label}{" "}
              <button
                className="link-btn"
                onClick={() =>
                  api
                    .post(`/roles/builtin/${r.key}/reset`)
                    .then(() => (toast(`${r.label} restored`), loadRoles()))
                    .catch((e) => toast(errMsg(e), "error"))
                }
              >
                restore
              </button>
            </span>
          ))}
        </p>
      )}
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
      <Modal
        open={!!link}
        title="Invitation ready"
        onClose={() => setLink(null)}
        footer={
          <button className="btn btn-primary" onClick={() => setLink(null)}>
            Done
          </button>
        }
      >
        {link && (
          <>
            <p>
              {link.emailed
                ? `We emailed the invitation to ${link.email || link.user?.email}. You can also share this link:`
                : "Email isn't set up on this server, so send this link to the person yourself (WhatsApp, email…). It works for 7 days."}
            </p>
            <div className="inline-add">
              <input
                readOnly
                value={link.link}
                onFocus={(e) => e.target.select()}
              />
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
      <Confirm
        open={!!del}
        title={`Remove ${del?.name}?`}
        text="They will no longer be able to sign in. Their past work stays."
        confirmLabel="Remove"
        onConfirm={() =>
          act(() => api.delete(`/users/${del._id}`), "User removed").then(() =>
            setDel(null),
          )
        }
        onCancel={() => setDel(null)}
      />
    </>
  );
}

function UserModal({ roles, user, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: user?.name || "",
    email: user?.email || "",
    roles: user?.roles || (user?.role ? [user.role] : ["staff"]),
  });
  // Admin already has everything, so it's on its own; other roles can be combined.
  const toggle = (k) => {
    const on = form.roles.includes(k);
    if (k === "admin") return setForm({ ...form, roles: on ? [] : ["admin"] });
    const rest = form.roles.filter((x) => x !== "admin");
    setForm({
      ...form,
      roles: on ? rest.filter((x) => x !== k) : [...rest, k],
    });
  };
  const setMain = (k) =>
    setForm({ ...form, roles: [k, ...form.roles.filter((x) => x !== k)] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (user) {
        await api.put(`/users/${user._id}`, {
          name: form.name,
          roles: form.roles,
        });
        toast("User updated");
        onSaved();
      } else {
        const { data } = await api.post("/users", {
          name: form.name,
          email: form.email,
          roles: form.roles,
        });
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
          <button
            className="btn btn-primary"
            disabled={busy || !form.roles.length}
            onClick={save}
          >
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
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />
        </Field>
        <Field label="Email" required>
          <input
            type="email"
            value={form.email}
            disabled={!!user}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field
          label="Roles"
          required
          hint="Tick one or more. With several roles they get everything each role allows."
        >
          <div className="role-grid">
            {roles.map((r) => (
              <label
                key={r.key}
                className={`role-card ${form.roles.includes(r.key) ? "on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={form.roles.includes(r.key)}
                  onChange={() => toggle(r.key)}
                />
                <span>
                  <strong>{r.label}</strong>
                  <div className="muted small">{r.desc}</div>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {form.roles.length > 1 && (
          <Field
            label="Main role"
            hint="Decides the page they open on after logging in"
          >
            <select
              value={form.roles[0]}
              onChange={(e) => setMain(e.target.value)}
            >
              {form.roles.map((k) => (
                <option key={k} value={k}>
                  {roles.find((r) => r.key === k)?.label || k}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

const HOMES = [
  ["", "Dashboard (or first page they can open)"],
  ["/returns-scan", "Scan Returns"],
  ["/shopify-orders", "Store orders"],
  ["/inbox", "Inbox"],
  ["/inventory", "Inventory"],
  ["/invoices", "Invoices"],
  ["/bills", "Bills"],
  ["/reports", "Reports"],
];

// Pages whose level differs from their module's.
const pageOverrides = (perms, m) =>
  (m.features || []).filter(
    (f) => perms[f.key] && perms[f.key] !== (perms[m.key] || "none"),
  );

const LEVELS = ["none", "view", "full"];
function Seg({ value, onChange }) {
  return (
    <>
      {LEVELS.map((l) => (
        <label key={l} className={`seg-btn ${value === l ? "on" : ""}`}>
          <input
            type="radio"
            checked={value === l}
            onChange={() => onChange(l)}
          />
          {l === "none" ? "No access" : l === "view" ? "View" : "Full"}
        </label>
      ))}
    </>
  );
}

function RoleModal({ role, modules, onClose, onSaved }) {
  const [f, setF] = useState(role);
  const [expanded, setExpanded] = useState(() =>
    Object.fromEntries(
      modules
        .filter((m) => pageOverrides(role.perms, m).length)
        .map((m) => [m.key, true]),
    ),
  );
  // Changing a module sets all its pages to the same level; pages can then be changed one by one.
  const setModule = (m, l) => {
    const perms = { ...f.perms, [m.key]: l };
    for (const x of m.features || []) delete perms[x.key];
    setF({ ...f, perms });
  };
  const pageLevel = (m, x) => f.perms[x.key] || f.perms[m.key] || "none";
  const setPage = (m, x, l) => {
    setF({ ...f, perms: { ...f.perms, [x.key]: l } });
  };
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: f.name,
        desc: f.desc || "",
        home: f.home || "",
        perms: f.perms,
      };
      if (f.builtin) await api.put(`/roles/builtin/${f.builtin}`, body);
      else if (f._id) await api.put(`/roles/${f._id}`, body);
      else await api.post("/roles", body);
      toast("Role saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        `Delete the role "${role.name}"?${f.builtin ? " You can restore it later from the roles list." : ""}`,
      )
    )
      return;
    try {
      await api.delete(
        f.builtin ? `/roles/builtin/${f.builtin}` : `/roles/${f._id}`,
      );
      toast("Role deleted");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const setAll = (lvl) =>
    setF({ ...f, perms: Object.fromEntries(modules.map((m) => [m.key, lvl])) });
  const pageNote = (m) => {
    const o = pageOverrides(f.perms, m);
    return o.length
      ? `${o.length} page${o.length > 1 ? "s" : ""} set separately`
      : "";
  };
  return (
    <Modal
      open
      wide
      title={f._id || f.builtin ? `Edit role: ${role.name}` : "New role"}
      onClose={onClose}
      footer={
        <>
          {(f._id || f.builtin) && (
            <button className="btn btn-ghost" onClick={remove}>
              Delete
            </button>
          )}
          {f.builtin && f.edited && (
            <button
              className="btn btn-ghost"
              onClick={() =>
                window.confirm(
                  `Put "${role.name}" back to OrdexaGo's original access?`,
                ) &&
                api
                  .post(`/roles/builtin/${f.builtin}/reset`)
                  .then(() => (toast("Role reset"), onSaved()))
                  .catch((e) => toast(errMsg(e), "error"))
              }
            >
              Reset to default
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.name.trim()}
            onClick={save}
          >
            Save Role
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-2">
          <Field label="Role name" required>
            <input
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="e.g. Returns Desk"
              autoFocus
            />
          </Field>
          <Field label="Opens on">
            <select
              value={f.home}
              onChange={(e) => setF({ ...f, home: e.target.value })}
            >
              {HOMES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input
            value={f.desc}
            onChange={(e) => setF({ ...f, desc: e.target.value })}
          />
        </Field>
        <div className="row-actions">
          <span className="muted small">Set all:</span>
          {["none", "view", "full"].map((l) => (
            <button
              key={l}
              type="button"
              className="btn btn-sm"
              onClick={() => setAll(l)}
            >
              {LEVEL[l]}
            </button>
          ))}
        </div>
        <table className="table compact perm-edit">
          <tbody>
            {modules.map((m) => [
              <tr key={m.key}>
                <td>
                  <strong>{m.label}</strong>
                  <div className="muted small">{m.desc}</div>
                  {m.features?.length > 0 && (
                    <button
                      type="button"
                      className="link-btn small"
                      onClick={() =>
                        setExpanded({ ...expanded, [m.key]: !expanded[m.key] })
                      }
                    >
                      {expanded[m.key]
                        ? "▾ Hide pages"
                        : "▸ Set access page by page"}
                      {pageNote(m) && ` · ${pageNote(m)}`}
                    </button>
                  )}
                </td>
                <td className="seg">
                  <Seg
                    value={f.perms[m.key] || "none"}
                    onChange={(l) => setModule(m, l)}
                  />
                </td>
              </tr>,
              expanded[m.key] &&
                (m.features || []).map((x) => (
                  <tr key={x.key} className="perm-page">
                    <td style={{ paddingLeft: 28 }}>{x.label}</td>
                    <td className="seg">
                      <Seg
                        value={pageLevel(m, x)}
                        onChange={(l) => setPage(m, x, l)}
                      />
                    </td>
                  </tr>
                )),
            ])}
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
  const [pending, setPending] = useState(null);
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
    if (form.password !== form.confirm)
      return setError("Passwords don't match");
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(`/auth/invite/${id}/${token}`, {
        name: form.name,
        password: form.password,
      });
      if (data.step) return setPending(data);
      signIn(data);
      navigate("/");
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  if (pending)
    return <SignInSteps start={pending} onCancel={() => navigate("/login")} />;
  return (
    <AuthShell
      title={info ? `Join ${info.organization}` : "Accept invitation"}
      subtitle={
        info
          ? `You've been invited as ${info.role}. Set a password for ${info.email}.`
          : ""
      }
    >
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
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Password" required hint={PASSWORD_HINT}>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Confirm Password" required>
            <input
              type="password"
              required
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
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
