import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import api, { errMsg } from "../lib/api";
import {
  PageHeader,
  Spinner,
  Empty,
  SearchBox,
  Modal,
  Field,
  toast,
} from "../components/ui";
import { money } from "../lib/format";

// Store → Abandoned Checkouts: Shopify checkouts the buyer left before paying, read live from Shopify.
// Each one can be followed up on WhatsApp (click-to-chat with the recovery link) or by copying the link, and the
// team keeps remarks (what was said), a status and the next follow-up date on it — kept in OrdexaGo.

const STATUS_PILL = {
  Interested: "pill-green",
  "Will order later": "pill-amber", "Price / shipping query": "pill-amber", "No answer": "",
  Ordered: "pill-green",
  "Not interested": "pill-red",
  "Wrong number": "pill-red",
};
const day = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
      })
    : "";
const isDue = (f) =>
  f?.nextOn &&
  new Date(f.nextOn) <= new Date(new Date().setHours(23, 59, 59, 999)) &&
  !["Ordered", "Not interested"].includes(f.status);

function RemarksModal({ row, statuses, onClose, onSaved }) {
  const { user } = useAuth();
  const full = can(user, "store_orders", "full");
  const f = row.followUp || {};
  const [text, setText] = useState("");
  const [status, setStatus] = useState(f.status || "");
  const [nextOn, setNextOn] = useState(
    f.nextOn ? String(f.nextOn).slice(0, 10) : "",
  );
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/shopify/abandoned-checkouts/${row.id}/remarks`,
        {
          text,
          status,
          nextOn: nextOn || null,
          customerKey: row.customerKey || "",
          customer: row.customer || "",
          phone: row.phone || "",
        },
      );
      toast("Saved");
      onSaved(data, true);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const del = async (n) => {
    if (!window.confirm("Delete this remark?")) return;
    try {
      const { data } = await api.delete(
        `/shopify/abandoned-checkouts/${row.id}/remarks/${n._id}`,
      );
      onSaved(data, false);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const notes = [...(f.notes || [])].reverse();
  return (
    <Modal
      open
      title={`Remarks — ${row.customer || "checkout"} #${row.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              (!text.trim() &&
                status === (f.status || "") &&
                nextOn === (f.nextOn ? String(f.nextOn).slice(0, 10) : ""))
            }
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Remark — what was said to the customer">
          <textarea
            rows={3}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Called, asked for 10% off, will confirm tomorrow"
          />
        </Field>
        <div className="row-2">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">— none —</option>
              {statuses.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Next follow-up">
            <input
              type="date"
              value={nextOn}
              onChange={(e) => setNextOn(e.target.value)}
            />
          </Field>
        </div>
      </div>
      {notes.length > 0 && <h4 className="section-title">This checkout</h4>}
      {notes.map((n) => (
        <div
          key={n._id}
          className="small"
          style={{
            borderLeft: "3px solid var(--border)",
            padding: "2px 0 2px 10px",
            marginBottom: 8,
          }}
        >
          <div className="muted">
            {n.by || "—"} · {when(n.at)}
            {n.status && (
              <span
                className={`pill ${STATUS_PILL[n.status] || ""}`}
                style={{ marginLeft: 6 }}
              >
                {n.status}
              </span>
            )}
            {(full || n.byId === user?._id) && (
              <button
                type="button"
                className="link-btn"
                style={{ marginLeft: 8 }}
                onClick={() => del(n)}
              >
                delete
              </button>
            )}
          </div>
          {n.text && <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>}
        </div>
      ))}
      {row.earlier?.length > 0 && (
        <>
          <h4 className="section-title">Same customer, earlier checkouts</h4>
          {row.earlier.map((n, i) => (
            <div
              key={i}
              className="small"
              style={{
                borderLeft: "3px solid var(--border)",
                padding: "2px 0 2px 10px",
                marginBottom: 8,
              }}
            >
              <div className="muted">
                #{n.checkout} · {n.by || "—"} · {when(n.at)}
                {n.status && (
                  <span
                    className={`pill ${STATUS_PILL[n.status] || ""}`}
                    style={{ marginLeft: 6 }}
                  >
                    {n.status}
                  </span>
                )}
              </div>
              {n.text && <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

const when = (d) =>
  new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const waNumber = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return `91${d}`;
  return d.replace(/^0+/, "");
};

export default function AbandonedCheckouts() {
  const nav = useNavigate();
  const { user } = useAuth();
  const canCreate = can(user, "store_orders.new_order", "full");
  const canRemark = can(user, "store_orders.abandoned", "full");
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  // Filter: "" all (live from Shopify), "none" no remarks yet (of the loaded ones), "due", "any", or a status.
  const [filter, setFilter] = useState("");
  const [statuses, setStatuses] = useState([]);
  const [remarksFor, setRemarksFor] = useState(null);
  useEffect(() => {
    api
      .get("/shopify/abandoned-checkouts/statuses")
      .then((r) => setStatuses(r.data))
      .catch(() => {});
  }, []);
  const serverFilter = filter && filter !== "none" ? filter : "";
  const load = async (after = null, query = q) => {
    setBusy(true);
    try {
      const { data } = await api.get("/shopify/abandoned-checkouts", {
        params: {
          after: after || undefined,
          q: serverFilter ? undefined : query || undefined,
          status:
            serverFilter && serverFilter !== "due" ? serverFilter : undefined,
          due: serverFilter === "due" ? 1 : undefined,
        },
      });
      setRows((r) => (after ? [...(r || []), ...data.rows] : data.rows));
      setNext(data.next);
    } catch (e) {
      toast(errMsg(e), "error");
      if (!after) setRows([]);
    }
    setBusy(false);
  };
  useEffect(() => {
    const t = setTimeout(() => load(null, q), q ? 400 : 0);
    return () => clearTimeout(t);
  }, [q, serverFilter]);
  const savedRemarks = (fu, close) => {
    setRows((rs) =>
      rs.map((r) => (r.id === remarksFor.id ? { ...r, followUp: fu } : r)),
    );
    setRemarksFor((x) => (close ? null : { ...x, followUp: fu }));
  };

  const message = (r) => {
    const first = (r.customer || "").split(" ")[0];
    const item = r.items[0]
      ? `${r.items[0].title}${r.items.length > 1 ? ` and ${r.items.length - 1} more` : ""}`
      : "your items";
    return `Hi${first ? ` ${first}` : ""}, you left ${item} in your cart. You can complete your order here: ${r.url}`;
  };
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast("Couldn't copy — select and copy it by hand", "error");
    }
  };

  const shown =
    filter === "none"
      ? (rows || []).filter(
          (r) => !r.followUp?.notes?.length && !r.followUp?.status,
        )
      : rows || [];
  const total = shown.reduce((t, r) => t + r.total, 0);
  const FILTERS = [
    ["", "All"],
    ["due", "Follow-up due"],
    ["none", "No remarks yet"],
    ["any", "With remarks"],
    ...statuses.map((x) => [x, x]),
  ];
  return (
    <>
      <PageHeader
        title="Abandoned Checkouts"
        subtitle="Shopify checkouts left before paying — follow them up on WhatsApp or by email"
      >
        <button className="btn" disabled={busy} onClick={() => load(null)}>
          Refresh
        </button>
      </PageHeader>
      <div className="tabs" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {FILTERS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={`tab ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="toolbar">
        {!serverFilter && (
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder="Search name, email, phone…"
          />
        )}
        {rows && (
          <span className="muted small">
            {shown.length} checkouts · {money(total)} left in carts
            {next ? " (more below)" : ""}
          </span>
        )}
      </div>
      {rows === null ? (
        <Spinner />
      ) : !shown.length ? (
        <Empty
          title="No abandoned checkouts"
          text={
            filter
              ? "No checkouts with this filter" +
                (filter === "none" && next
                  ? " in the loaded ones — load more"
                  : "") +
                "."
              : q
                ? "Nothing matches the search."
                : "Checkouts left before payment show up here."
          }
        />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Customer</th>
                <th>Items</th>
                <th className="num">Cart value</th>
                <th>Remarks</th>
                <th>Follow up</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td data-label="Started">
                    {when(r.createdAt)}
                    <div className="muted small">#{r.id}</div>
                  </td>
                  <td data-label="Customer">
                    <strong>{r.customer || "—"}</strong>
                    {r.orders > 0 && (
                      <span
                        className="pill pill-green"
                        style={{ marginLeft: 6 }}
                      >
                        {r.orders} past order{r.orders > 1 ? "s" : ""}
                      </span>
                    )}
                    <div className="small">
                      {[r.phone, r.email].filter(Boolean).join(" · ")}
                    </div>
                    {r.city && <div className="muted small">{r.city}</div>}
                  </td>
                  <td data-label="Items">
                    {r.items.map((l, i) => (
                      <div
                        key={i}
                        className="small"
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          marginBottom: 2,
                        }}
                      >
                        {l.image && (
                          <img
                            src={l.image}
                            alt=""
                            width={28}
                            height={28}
                            style={{ objectFit: "cover", borderRadius: 4 }}
                          />
                        )}
                        <span>
                          {l.quantity} × {l.title}
                          {l.variant ? ` — ${l.variant}` : ""}
                          {l.sku && <span className="muted"> · {l.sku}</span>}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td data-label="Cart value" className="num">
                    {money(r.total)}
                  </td>
                  <td data-label="Remarks" style={{ maxWidth: 260 }}>
                    {r.gone && (
                      <div className="muted small">
                        No longer in Shopify (completed or expired)
                      </div>
                    )}
                    {r.followUp?.status && (
                      <span
                        className={`pill ${STATUS_PILL[r.followUp.status] || ""}`}
                      >
                        {r.followUp.status}
                      </span>
                    )}
                    {r.followUp?.orderName && (
                      <span className="small"> {r.followUp.orderName}</span>
                    )}
                    {r.followUp?.nextOn &&
                      !["Ordered", "Not interested"].includes(
                        r.followUp.status,
                      ) && (
                        <div
                          className={`small ${isDue(r.followUp) ? "text-red" : "muted"}`}
                        >
                          Follow up {day(r.followUp.nextOn)}
                        </div>
                      )}
                    {(() => {
                      const last = [...(r.followUp?.notes || [])]
                        .reverse()
                        .find((n) => n.text);
                      return last ? (
                        <div
                          className="small"
                          title={last.text}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                          }}
                        >
                          {last.text}{" "}
                          <span className="muted">
                            — {last.by}, {day(last.at)}
                          </span>
                        </div>
                      ) : null;
                    })()}
                    {r.earlier?.length > 0 && (
                      <div className="muted small">
                        {r.earlier.length} remark(s) on this customer's other
                        checkouts
                      </div>
                    )}
                    {(canRemark ||
                      r.followUp?.notes?.length > 0 ||
                      r.earlier?.length > 0) && (
                      <button
                        type="button"
                        className="link-btn small"
                        onClick={() => setRemarksFor(r)}
                      >
                        {canRemark
                          ? r.followUp?.notes?.length
                            ? `Remarks (${r.followUp.notes.length}) · add`
                            : "+ Add remark"
                          : "View remarks"}
                      </button>
                    )}
                  </td>
                  <td data-label="Follow up">
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {r.phone && (
                        <a
                          className="btn btn-sm btn-primary"
                          href={`https://wa.me/${waNumber(r.phone)}?text=${encodeURIComponent(message(r))}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WhatsApp
                        </a>
                      )}
                      {r.email && (
                        <a
                          className="btn btn-sm"
                          href={`mailto:${r.email}?subject=${encodeURIComponent("Your cart is waiting")}&body=${encodeURIComponent(message(r))}`}
                        >
                          Email
                        </a>
                      )}
                      {canCreate &&
                        !r.gone &&
                        r.items.some((l) => l.variantId) && (
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              nav("/shopify-orders/new", {
                                state: { checkout: r },
                              })
                            }
                            title="Make the order for the customer from this cart (COD, paid or payment link)"
                          >
                            Create order
                          </button>
                        )}
                      {r.url && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => copy(r.url, "Recovery link")}
                        >
                          Copy link
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {next && (
            <div className="pad center">
              <button
                className="btn"
                disabled={busy}
                onClick={() => load(next)}
              >
                {busy ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
      {remarksFor && (
        <RemarksModal
          row={remarksFor}
          statuses={statuses}
          onClose={() => setRemarksFor(null)}
          onSaved={savedRemarks}
        />
      )}
    </>
  );
}
