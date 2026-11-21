import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Empty, SearchBox, toast } from "../components/ui";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import {
  STATUS_PILL,
  when,
  Thread,
  ReplyBox,
} from "../components/TicketThread";

// Store → Seller Tickets: every seller's support tickets by status; open one to answer, note, assign, resolve.

const PRIORITY_PILL = {
  urgent: "pill-red",
  high: "pill-amber",
  normal: "",
  low: "",
};
const ageOf = (d) => {
  const h = (Date.now() - new Date(d)) / 3600000;
  return h < 1
    ? `${Math.max(1, Math.round(h * 60))} min`
    : h < 48
      ? `${Math.round(h)} h`
      : `${Math.round(h / 24)} days`;
};

export default function Tickets() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get("status") || "active";
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState({
    categories: [],
    statuses: [],
    priorities: [],
  });
  const [staff, setStaff] = useState([]);
  const [sellers, setSellers] = useState([]);
  const [q, setQ] = useState(sp.get("q") || "");
  const f = {
    seller: sp.get("seller") || "",
    category: sp.get("category") || "",
    assignee: sp.get("assignee") || "",
    priority: sp.get("priority") || "",
  };
  const setParam = (k, v) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  useEffect(() => {
    api
      .get("/tickets/options")
      .then((r) => setOpts(r.data))
      .catch(() => {});
    api
      .get("/tickets/staff")
      .then((r) => setStaff(r.data))
      .catch(() => {});
    api
      .get("/sellers")
      .then((r) => setSellers(r.data))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(
      () => {
        api
          .get("/tickets", {
            params: {
              status,
              q: q || undefined,
              ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)),
            },
          })
          .then((r) => setData(r.data))
          .catch(
            (e) => (
              toast(errMsg(e), "error"),
              setData({ rows: [], counts: {} })
            ),
          );
      },
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [status, q, f.seller, f.category, f.assignee, f.priority]);

  const c = data?.counts || {};
  const TABS = [
    ["active", "All active"],
    ["open", "Open"],
    ["in_progress", "Work in progress"],
    ["waiting", "Waiting for seller"],
    ["unassigned", "Unassigned"],
    ["mine", "Assigned to me"],
    ["resolved", "Resolved"],
    ["closed", "Closed"],
    ["all", "All"],
  ];
  return (
    <>
      <PageHeader
        title="Seller Tickets"
        subtitle="Problems sellers raise from their dashboard — answer, assign and resolve them here"
      />
      <div className="tabs" style={{ flexWrap: "wrap" }}>
        {TABS.map(([k, l]) => (
          <button
            key={k}
            className={`tab ${status === k ? "active" : ""}`}
            onClick={() => setParam("status", k === "active" ? "" : k)}
          >
            {l}
            <span
              className={`tab-count ${k === "open" && c.open ? "red" : ""}`}
            >
              {c[k] ?? 0}
            </span>
          </button>
        ))}
      </div>
      <div className="toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <SearchBox
          value={q}
          onChange={(v) => (setQ(v), setParam("q", v))}
          placeholder="Ticket no., subject, seller, order…"
        />
        <select
          value={f.seller}
          onChange={(e) => setParam("seller", e.target.value)}
        >
          <option value="">All sellers</option>
          {sellers.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={f.category}
          onChange={(e) => setParam("category", e.target.value)}
        >
          <option value="">All topics</option>
          {opts.categories.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select
          value={f.priority}
          onChange={(e) => setParam("priority", e.target.value)}
        >
          <option value="">Any priority</option>
          {opts.priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={f.assignee}
          onChange={(e) => setParam("assignee", e.target.value)}
        >
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {staff.map((u) => (
            <option key={u._id} value={u._id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      {data === null ? (
        <Spinner />
      ) : !data.rows.length ? (
        <Empty
          title="No tickets here"
          text={
            status === "active"
              ? "No open tickets — sellers raise them from their dashboard (Support tab)."
              : "Nothing with these filters."
          }
        />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Seller</th>
                <th>Subject</th>
                <th>Order</th>
                <th>Priority</th>
                <th>Assigned</th>
                <th>Status</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((t) => (
                <tr key={t._id} className="clickable">
                  <td data-label="Ticket">
                    <Link to={`/tickets/${t._id}`}>
                      <strong>{t.ticketNo}</strong>
                    </Link>
                    {t.teamUnread > 0 && (
                      <span
                        className="pill pill-blue"
                        style={{ marginLeft: 6 }}
                      >
                        {t.teamUnread} new
                      </span>
                    )}
                    <div className="muted small">{ageOf(t.createdAt)} old</div>
                  </td>
                  <td data-label="Seller">{t.sellerName}</td>
                  <td data-label="Subject">
                    <Link to={`/tickets/${t._id}`} style={{ color: "inherit" }}>
                      {t.subject}
                    </Link>
                    <div className="muted small">{t.categoryLabel}</div>
                  </td>
                  <td data-label="Order">{t.orderName || "—"}</td>
                  <td data-label="Priority">
                    <span className={`pill ${PRIORITY_PILL[t.priority] || ""}`}>
                      {t.priority}
                    </span>
                  </td>
                  <td data-label="Assigned">
                    {t.assignee?.name || <span className="muted">—</span>}
                  </td>
                  <td data-label="Status">
                    <span className={`pill ${STATUS_PILL[t.status] || ""}`}>
                      {t.statusLabel}
                    </span>
                  </td>
                  <td data-label="Last activity">
                    {when(t.lastActivityAt)}
                    <div className="muted small">
                      {t.lastFrom === "seller" ? "by seller" : "by team"}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const edit = can(user, "tickets", "full");
  const [t, setT] = useState(null);
  const [opts, setOpts] = useState({
    categories: [],
    statuses: [],
    priorities: [],
  });
  const [staff, setStaff] = useState([]);
  const load = () =>
    api
      .get(`/tickets/${id}`)
      .then((r) => setT(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
    api
      .get("/tickets/options")
      .then((r) => setOpts(r.data))
      .catch(() => {});
    api
      .get("/tickets/staff")
      .then((r) => setStaff(r.data))
      .catch(() => {});
  }, [id]);
  if (!t) return <Spinner />;
  const update = async (body) => {
    try {
      setT((await api.put(`/tickets/${id}`, body)).data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <PageHeader
        title={`${t.ticketNo} · ${t.subject}`}
        subtitle={`${t.sellerName} · ${t.categoryLabel} · raised ${when(t.createdAt)} by ${t.raisedBy?.name || t.sellerName}`}
      >
        <button className="btn" onClick={() => nav("/tickets")}>
          All tickets
        </button>
      </PageHeader>
      <div className="ticket-layout">
        <div>
          <div className="card">
            <Thread
              team
              messages={t.messages}
              fileUrl={(f) => `/tickets/${id}/files/${f._id}`}
            />
          </div>
          {edit && (
            <ReplyBox
              team
              statuses={opts.statuses}
              onSend={async (body) =>
                setT((await api.post(`/tickets/${id}/reply`, body)).data)
              }
            />
          )}
        </div>
        <div className="card ticket-side">
          <div className="label-sm">Status</div>
          <select
            value={t.status}
            disabled={!edit}
            onChange={(e) => update({ status: e.target.value })}
          >
            {opts.statuses.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <div className="label-sm">Assigned to</div>
          <select
            value={t.assignee?.user || ""}
            disabled={!edit}
            onChange={(e) => update({ assignee: e.target.value || null })}
          >
            <option value="">— nobody —</option>
            {staff.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name}
              </option>
            ))}
          </select>
          {edit && t.assignee?.user !== user?._id && (
            <button
              type="button"
              className="link-btn small"
              onClick={() => update({ assignee: user._id })}
            >
              Assign to me
            </button>
          )}
          <div className="label-sm">Priority</div>
          <select
            value={t.priority}
            disabled={!edit}
            onChange={(e) => update({ priority: e.target.value })}
          >
            {opts.priorities.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <div className="label-sm">Topic</div>
          <select
            value={t.category}
            disabled={!edit}
            onChange={(e) => update({ category: e.target.value })}
          >
            {opts.categories.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {t.orderName && (
            <>
              <div className="label-sm">Order</div>
              <Link
                to={`/shopify-orders?q=${encodeURIComponent(t.orderName)}&tab=all`}
              >
                {t.orderName}
              </Link>
            </>
          )}
          <div className="label-sm">Seller</div>
          <div>{t.sellerName}</div>
          <div className="small muted">
            {[t.raisedBy?.name, t.raisedBy?.email].filter(Boolean).join(" · ")}
          </div>
          <div className="label-sm">Timeline</div>
          <div className="small">
            Raised {when(t.createdAt)}
            {t.firstResponseAt && (
              <div>First reply {when(t.firstResponseAt)}</div>
            )}
            {t.resolvedAt && <div>Resolved {when(t.resolvedAt)}</div>}
            {t.closedAt && <div>Closed {when(t.closedAt)}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
