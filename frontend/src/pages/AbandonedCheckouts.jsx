import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Empty, SearchBox, toast } from "../components/ui";
import { money } from "../lib/format";

// Store → Abandoned Checkouts: Shopify checkouts the buyer left before paying, read live from Shopify.
// Each one can be followed up on WhatsApp (click-to-chat with the recovery link) or by copying the link.

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
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (after = null, query = q) => {
    setBusy(true);
    try {
      const { data } = await api.get("/shopify/abandoned-checkouts", {
        params: { after: after || undefined, q: query || undefined },
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
  }, [q]);

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

  const total = (rows || []).reduce((t, r) => t + r.total, 0);
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
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search name, email, phone…"
        />
        {rows && (
          <span className="muted small">
            {rows.length} checkouts · {money(total)} left in carts
            {next ? " (more below)" : ""}
          </span>
        )}
      </div>
      {rows === null ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          title="No abandoned checkouts"
          text={
            q
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
                <th>Follow up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                      {canCreate && r.items.some((l) => l.variantId) && (
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
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => copy(r.url, "Recovery link")}
                      >
                        Copy link
                      </button>
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
    </>
  );
}
