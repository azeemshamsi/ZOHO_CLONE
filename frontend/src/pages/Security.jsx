import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Spinner, SearchBox, useDebounced, toast } from "../components/ui";

export const isAdminUser = (user) => !!user && (user.superadmin || user.role === "admin");

const LABELS = {
  login: "Signed in",
  login_failed: "Failed sign-in",
  login_blocked_locked: "Sign-in while locked",
  account_locked: "Account locked",
  logout: "Signed out",
  invite_accepted: "Invitation accepted",
  password_changed: "Password changed",
  password_reset_requested: "Password reset requested",
  password_reset: "Password reset",
  user_invited: "User invited",
  user_added: "User added",
  user_role_changed: "Role changed",
  user_status_changed: "User turned on/off",
  user_removed: "User removed",
  role_created: "Role created",
  role_updated: "Role edited",
  role_deleted: "Role deleted",
  amazon_order_view: "Amazon order viewed",
  amazon_label_download: "Amazon label downloaded",
  amazon_order_action: "Amazon order action",
  order_export: "Orders exported",
  data_export: "Data exported",
  file_download: "File downloaded",
  delete: "Deleted",
  settings_changed: "Settings changed",
  credentials_changed: "Credentials changed",
  device_blocked: "Unapproved device blocked",
  device_approval_requested: "Device approval requested",
  device_approved: "Device approved",
  device_revoked: "Device revoked",
  device_renamed: "Device renamed",
  "2fa_enabled": "Two-step login turned on",
  "2fa_reset": "Two-step login reset",
  "2fa_recovery_used": "Recovery code used",
  "2fa_failed": "Wrong two-step code",
  backup_failed: "Backup failed",
};
export const actionLabel = (a) => LABELS[a] || String(a || "").replace(/_/g, " ");
const RED = new Set(["login_failed", "login_blocked_locked", "account_locked", "device_blocked", "credentials_changed", "2fa_failed", "2fa_reset", "backup_failed", "delete"]);

// [key, label, panel]
const TABS = [
  ["log", "Security log", SecurityLog],
  ["devices", "Devices", Devices],
];

export default function Security() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "log";
  const tabs = TABS;
  const Tab = (TABS.find(([k]) => k === tab) || TABS[0])[2];
  return (
    <>
      <PageHeader title="Security" subtitle="Who signed in, what they opened and changed, and which devices may open Amazon order data." />
      {tabs.length > 1 && (
        <div className="tabs">
          {tabs.map(([k, l]) => (
            <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setParams(k === "log" ? {} : { tab: k })}>
              {l}
            </button>
          ))}
        </div>
      )}
      <Tab />
    </>
  );
}

function SecurityLog() {
  const { user } = useAuth();
  const [f, setF] = useState({ from: "", to: "", action: "", scope: "" });
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 350);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const query = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(dq ? { q: dq } : {}) };
  useEffect(() => {
    let live = true;
    api
      .get("/security/log", { params: { ...query, page } })
      .then((r) => live && setData(r.data))
      .catch((e) => toast(errMsg(e), "error"));
    return () => {
      live = false;
    };
  }, [JSON.stringify(query), page]);
  const set = (k) => (e) => {
    setF({ ...f, [k]: e.target.value });
    setPage(1);
  };
  const exportCsv = async () => {
    try {
      const r = await api.get("/security/log.csv", { params: query, responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.data);
      a.download = "security-log.csv";
      a.click();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <div className="card flush">
      <div className="filter-bar">
        <SearchBox value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="User, IP, order, page…" />
        <select value={f.action} onChange={set("action")}>
          <option value="">All events</option>
          {(data?.actions || []).map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <input type="date" value={f.from} onChange={set("from")} title="From" />
        <input type="date" value={f.to} onChange={set("to")} title="To" />
        {user?.superadmin && (
          <select value={f.scope} onChange={set("scope")}>
            <option value="">This company</option>
            <option value="all">All companies</option>
          </select>
        )}
        <button className="btn btn-sm" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.rows.length ? (
        <p className="muted center" style={{ padding: 24 }}>
          Nothing logged for these filters.
        </p>
      ) : (
        <div className="table-wrap" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time (IST)</th>
                <th>User</th>
                <th>Event</th>
                <th>Target</th>
                <th>IP</th>
                <th>Device</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r._id}>
                  <td className="nowrap small">{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  <td className="small">
                    {r.userName || "—"}
                    <div className="muted">{r.userEmail}</div>
                  </td>
                  <td className={RED.has(r.action) ? "text-overdue small" : "small"}>{actionLabel(r.action)}</td>
                  <td className="small" style={{ maxWidth: 280, wordBreak: "break-word" }}>
                    {r.target}
                    {r.meta && Object.keys(r.meta).length > 0 && <div className="muted">{Object.entries(r.meta).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 200)}</div>}
                  </td>
                  <td className="small mono">{r.ip}</td>
                  <td className="small" title={r.userAgent}>
                    <span className="mono">{(r.deviceId || "").slice(0, 8)}</span>
                    <div className="muted">{browserOf(r.userAgent)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.limit && (
        <div className="filter-bar" style={{ justifyContent: "space-between" }}>
          <span className="muted small">
            {data.total}
            {data.capped ? "+" : ""} entries · page {page} of {pages}
          </span>
          <span>
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>{" "}
            <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function browserOf(ua = "") {
  if (!ua) return "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${b}${os ? ` on ${os}` : ""}`;
}

// Approve, revoke and rename the browsers people use. Only non-admin users need an approved device, and only
// for Amazon order data (order details, labels, Easy Ship, exports with Amazon orders).
function Devices() {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/security/devices").then((r) => setRows(r.data)).catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, []);
  const save = async (d, body, msg) => {
    try {
      await api.put(`/security/devices/${d._id}`, body);
      toast(msg);
      setEdit(null);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  if (!rows) return <Spinner />;
  return (
    <div className="card flush">
      <p className="muted small" style={{ padding: "12px 16px 0" }}>
        Staff can open Amazon order details, labels, Easy Ship and order exports with Amazon orders only from a device approved here. Admins aren't restricted; their first device is approved automatically. A device appears once its user signs in.
      </p>
      {!rows.length ? (
        <p className="muted center" style={{ padding: 24 }}>
          No devices yet.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Device</th>
                <th>Last seen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d._id}>
                  <td className="small">
                    {d.userName}
                    {d.userIsAdmin && <span className="muted"> · admin</span>}
                    <div className="muted">{d.userEmail}</div>
                  </td>
                  <td className="small">
                    {edit?._id === d._id ? (
                      <span style={{ display: "flex", gap: 6 }}>
                        <input value={edit.name} maxLength={60} autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                        <button className="btn btn-sm btn-primary" onClick={() => save(d, { name: edit.name }, "Renamed")}>
                          Save
                        </button>
                      </span>
                    ) : (
                      <>
                        <strong>{d.name || browserOf(d.userAgent) || "Device"}</strong>
                        {d.current && <span className="muted"> (this browser)</span>}
                        <div className="muted" title={d.userAgent}>
                          {browserOf(d.userAgent)} · <span className="mono">{d.deviceId.slice(0, 8)}</span> {d.ip && `· ${d.ip}`}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="small nowrap">{d.lastSeen ? new Date(d.lastSeen).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</td>
                  <td className="small">
                    {d.approved ? (
                      <span className="status status-paid">Approved</span>
                    ) : d.requestedAt ? (
                      <span className="status status-overdue">Approval requested</span>
                    ) : (
                      <span className="status status-draft">Not approved</span>
                    )}
                  </td>
                  <td className="right nowrap">
                    {d.approved ? (
                      <button className="btn btn-sm" onClick={() => save(d, { approved: false }, "Device revoked")}>
                        Revoke
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-primary" onClick={() => save(d, { approved: true }, "Device approved")}>
                        Approve
                      </button>
                    )}{" "}
                    <button className="btn btn-sm btn-ghost" onClick={() => setEdit({ _id: d._id, name: d.name || "" })}>
                      Rename
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
