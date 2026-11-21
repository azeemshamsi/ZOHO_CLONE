import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { Spinner, Empty, Field, toast } from "./ui";
import {
  STATUS_PILL,
  when,
  FilePicker,
  filesPayload,
  Thread,
  ReplyBox,
} from "./TicketThread";

// Seller dashboard → Support: raise a ticket (order, payment, technical…) with screenshots; follow the replies.
export default function SellerTickets({ onCount }) {
  const [rows, setRows] = useState(null);
  const [opts, setOpts] = useState({ categories: [], statuses: [] });
  const [view, setView] = useState(null); // ticket id
  const [creating, setCreating] = useState(false);
  const load = () =>
    api
      .get("/seller-portal/tickets")
      .then((r) => setRows(r.data))
      .catch((e) => (toast(errMsg(e), "error"), setRows([])));
  useEffect(() => {
    load();
    api
      .get("/seller-portal/tickets/options")
      .then((r) => setOpts(r.data))
      .catch(() => {});
  }, []);
  if (view)
    return (
      <TicketView
        id={view}
        onBack={() => (setView(null), load(), onCount?.())}
      />
    );
  if (creating)
    return (
      <NewTicket
        opts={opts}
        onBack={() => setCreating(false)}
        onDone={(t) => (setCreating(false), load(), setView(t._id))}
      />
    );
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          margin: "6px 0 12px",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <p className="small muted" style={{ margin: 0 }}>
          Facing a problem with an order, a payment, a pickup or this dashboard?
          Raise a ticket and our team will get back to you here.
        </p>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Raise a ticket
        </button>
      </div>
      {rows === null ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          title="No tickets yet"
          text="When you raise a ticket, you can follow our team's replies here."
        />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Subject</th>
                <th>Order</th>
                <th>Status</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t._id}
                  className="clickable"
                  onClick={() => setView(t._id)}
                >
                  <td data-label="Ticket">
                    <strong>{t.number}</strong>
                    {t.unread > 0 && (
                      <span
                        className="pill pill-blue"
                        style={{ marginLeft: 6 }}
                      >
                        {t.unread} new
                      </span>
                    )}
                  </td>
                  <td data-label="Subject">
                    {t.subject}
                    <div className="muted small">{t.categoryLabel}</div>
                  </td>
                  <td data-label="Order">{t.orderName || "—"}</td>
                  <td data-label="Status">
                    <span className={`pill ${STATUS_PILL[t.status] || ""}`}>
                      {t.statusLabel}
                    </span>
                  </td>
                  <td data-label="Last update">{when(t.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewTicket({ opts, onBack, onDone }) {
  const [f, setF] = useState({
    category: "",
    subject: "",
    text: "",
    orderId: "",
  });
  const [files, setFiles] = useState([]);
  const [orders, setOrders] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(
      () =>
        api
          .get("/seller-portal/tickets/orders", { params: { q } })
          .then((r) => setOrders(r.data))
          .catch(() => {}),
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [q]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (!f.category) return toast("Choose what the problem is about", "error");
    setBusy(true);
    try {
      const { data } = await api.post("/seller-portal/tickets", {
        ...f,
        orderId: f.orderId || null,
        files: await filesPayload(files),
      });
      toast(`Ticket ${data.number} raised — we'll reply here`);
      onDone(data);
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const needsOrder = ["order", "shipping", "return", "payment"].includes(
    f.category,
  );
  return (
    <form className="card form" onSubmit={submit} style={{ maxWidth: 760 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Raise a ticket
      </h4>
      <div className="form-grid">
        <div className="row-2">
          <Field label="What is it about?" required>
            <select value={f.category} onChange={set("category")} required>
              <option value="">Choose…</option>
              {opts.categories.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={
              needsOrder ? "Order (if it's about one)" : "Order (optional)"
            }
          >
            <input
              list="ticket-orders"
              value={q}
              onChange={(e) => (
                setQ(e.target.value),
                setF({
                  ...f,
                  orderId:
                    (orders.find((o) => o.name === e.target.value) || {})._id ||
                    "",
                })
              )}
              placeholder="Type the order number, e.g. #201265"
            />
            <datalist id="ticket-orders">
              {orders.map((o) => (
                <option key={o._id} value={o.name}>
                  {new Date(o.orderDate).toLocaleDateString("en-IN")} ·{" "}
                  {o.status.replace(/_/g, " ")}
                </option>
              ))}
            </datalist>
            {q && !f.orderId && (
              <div className="small muted">Pick the order from the list</div>
            )}
          </Field>
        </div>
        <Field label="Subject" required>
          <input
            value={f.subject}
            onChange={set("subject")}
            maxLength={150}
            required
            placeholder="e.g. Pickup not done for #201265"
          />
        </Field>
        <Field
          label="Details"
          required
          hint="What happened, what you expected, and anything we should know"
        >
          <textarea
            rows={6}
            value={f.text}
            onChange={set("text")}
            required
            minLength={5}
          />
        </Field>
        <FilePicker files={files} setFiles={setFiles} />
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Sending…" : "Raise ticket"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TicketView({ id, onBack }) {
  const [t, setT] = useState(null);
  const load = () =>
    api
      .get(`/seller-portal/tickets/${id}`)
      .then((r) => setT(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, [id]);
  if (!t) return <Spinner />;
  const act = async (a) => {
    try {
      const { data } = await api.post(`/seller-portal/tickets/${id}/${a}`);
      setT(data);
      toast(a === "close" ? "Ticket closed" : "Ticket reopened");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div style={{ maxWidth: 860 }}>
      <button className="link-btn" onClick={onBack}>
        ← All tickets
      </button>
      <div className="card" style={{ marginTop: 8 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>
              {t.number} · {t.subject}
            </h3>
            <div className="small muted">
              {t.categoryLabel}
              {t.orderName ? ` · order ${t.orderName}` : ""} · raised{" "}
              {when(t.createdAt)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className={`pill ${STATUS_PILL[t.status] || ""}`}>
              {t.statusLabel}
            </span>
            {t.status === "resolved" && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => act("close")}
                title="Confirm it's sorted"
              >
                It's sorted — close
              </button>
            )}
            {["resolved", "closed"].includes(t.status) ? (
              <button className="btn btn-sm" onClick={() => act("reopen")}>
                Reopen
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  window.confirm("Close this ticket?") && act("close")
                }
              >
                Close
              </button>
            )}
          </div>
        </div>
        {t.status === "waiting" && (
          <div className="alert alert-warn" style={{ marginTop: 8 }}>
            Our team is waiting for your reply.
          </div>
        )}
        <Thread
          messages={t.messages}
          fileUrl={(f) => `/seller-portal/tickets/${id}/files/${f._id}`}
        />
      </div>
      {t.status !== "closed" ? (
        <ReplyBox
          onSend={async (body) =>
            setT(
              (await api.post(`/seller-portal/tickets/${id}/reply`, body)).data,
            )
          }
        />
      ) : (
        <p className="muted small">
          This ticket is closed. Reopen it to reply.
        </p>
      )}
    </div>
  );
}
