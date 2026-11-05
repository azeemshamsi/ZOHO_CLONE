import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { stateName } from "../lib/constants";
import { money, amount, date } from "../lib/format";
import { PageHeader, Spinner, Empty, Modal, SearchBox, useDebounced, toast } from "../components/ui";
import Icon from "../components/Icon";

// A marketplace seller's own dashboard: their orders and labels, their Shopify stock, purchase orders and penalties.

const STATUS = { new: "New", packed: "Packed", ready_to_ship: "Ready to ship", shipped: "Shipped", delivered: "Delivered", rto: "RTO", return_created: "Return requested", returned: "Returned", cancelled: "Cancelled" };
const STATUS_CLS = { new: "status-draft", packed: "status-sent", ready_to_ship: "status-sent", shipped: "status-open", delivered: "status-paid", rto: "status-overdue", return_created: "status-partially_paid", returned: "status-overdue", cancelled: "status-cancelled" };
const TRACK = { pending: "Awaiting pickup", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered", rto: "RTO", cancelled: "Cancelled by courier" };

async function openLabel(id) {
  const w = window.open("", "_blank");
  try {
    const r = await api.get(`/seller-portal/orders/${id}/label`, { responseType: "blob" });
    if (r.data.type === "application/json") {
      const j = JSON.parse(await r.data.text());
      if (j.url) {
        if (w) w.location = j.url;
        else window.open(j.url, "_blank");
        return;
      }
    }
    const u = URL.createObjectURL(r.data);
    if (w) w.location = u;
    else window.open(u, "_blank");
  } catch (e) {
    if (w) w.close();
    let m = errMsg(e);
    if (e?.response?.data instanceof Blob) m = JSON.parse(await e.response.data.text()).message || m;
    toast(m, "error");
  }
}

export default function SellerPortal() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("orders");
  useEffect(() => {
    api
      .get("/seller-portal/me")
      .then((r) => setMe(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!me) return <Spinner />;
  const s = me.seller;
  return (
    <>
      <PageHeader title={s.name} subtitle={`Seller dashboard · brands: ${s.brands.join(", ")}`} />
      <div className="seller-stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Stat label="Open orders" value={me.counts.open} onClick={() => setTab("orders")} />
        <Stat label="To ship (not booked)" value={(me.counts.new || 0) + (me.counts.packed || 0)} />
        <Stat label="Delivered, not on a PO yet" value={money(me.deliveredNotOnPo.amount)} sub={`${me.deliveredNotOnPo.orders} orders · at ${s.rate}%`} />
        <Stat label="Deductions pending" value={money(me.penaltiesPending)} onClick={() => setTab("penalties")} />
      </div>
      <div className="tabs">
        {[
          ["orders", "Orders"],
          ["stock", "Stock"],
          ["pos", "Purchase orders"],
          ["penalties", "Deductions"],
          ["profile", "Pickup address"],
        ].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "orders" && <Orders counts={me.counts} />}
      {tab === "stock" && <Stock />}
      {tab === "pos" && <Pos />}
      {tab === "penalties" && <Penalties />}
      {tab === "profile" && (
        <div className="card">
          <dl className="details">
            <dt>Pickup address</dt>
            <dd>{s.pickup?.address ? [s.pickup.name, s.pickup.address, s.pickup.city, stateName(s.pickup.state), s.pickup.pincode].filter(Boolean).join(", ") : "Not set"}</dd>
            <dt>Pickup phone</dt>
            <dd>{s.pickup?.phone || s.phone || "—"}</dd>
            <dt>GSTIN</dt>
            <dd>{s.gstin || "—"}</dd>
            <dt>Purchase rate</dt>
            <dd>{s.rate}% of the sale price (GST included, before the marketplace's discounts)</dd>
          </dl>
          <p className="small muted">To change your pickup address or details, contact the marketplace.</p>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, sub, onClick }) {
  return (
    <div className="card" style={{ padding: 14, cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

function Orders({ counts }) {
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    api
      .get("/seller-portal/orders", { params: { status, q: dq || undefined, page } })
      .then((r) => live && setData(r.data))
      .catch((e) => toast(errMsg(e), "error"));
    return () => {
      live = false;
    };
  }, [status, dq, page]);
  const pages = data ? Math.ceil(data.total / data.limit) : 1;
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} style={{ width: "auto" }}>
          <option value="open">Open ({counts.open})</option>
          <option value="all">All ({counts.all})</option>
          {Object.entries(STATUS).map(([k, l]) => (
            <option key={k} value={k}>
              {l} ({counts[k] || 0})
            </option>
          ))}
        </select>
        <SearchBox value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Order no, SKU, product, AWB, pincode" />
      </div>
      {!data ? (
        <Spinner />
      ) : !data.rows.length ? (
        <Empty title="No orders here" />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Your products</th>
                <th>Ship to</th>
                <th>Status</th>
                <th className="num">Your amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((o) => (
                <tr key={o._id}>
                  <td>
                    <div className="strong">{o.name}</div>
                    <div className="small muted">{date(o.orderDate)}</div>
                    <div className="small muted">{o.paymentMode === "cod" ? "COD" : o.paymentMode === "partial" ? "Part COD" : "Prepaid"}</div>
                  </td>
                  <td>
                    {o.lines.map((l, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        {l.image && <img src={l.image} alt="" width={34} height={34} style={{ objectFit: "cover", borderRadius: 4 }} />}
                        <div className="small">
                          <div>
                            {l.quantity} × {l.title}
                            {l.variantTitle ? ` - ${l.variantTitle}` : ""}
                          </div>
                          <div className="muted">{l.sku}</div>
                        </div>
                      </div>
                    ))}
                    {o.otherItems > 0 && <div className="small muted">+ {o.otherItems} item(s) from other sellers</div>}
                  </td>
                  <td className="small">
                    {o.shipTo.name}
                    <div className="muted">{[o.shipTo.city, o.shipTo.pincode].filter(Boolean).join(" ")}</div>
                  </td>
                  <td className="small">
                    <span className={`status ${STATUS_CLS[o.status] || ""}`}>{STATUS[o.status] || o.status}</span>
                    {o.shipment && (
                      <div style={{ marginTop: 4 }}>
                        {o.shipment.courierName} · {o.shipment.trackingUrl ? (
                          <a href={o.shipment.trackingUrl} target="_blank" rel="noreferrer">
                            {o.shipment.awb}
                          </a>
                        ) : (
                          o.shipment.awb
                        )}
                        {o.shipment.trackStatus && <div className="muted">{TRACK[o.shipment.trackStatus] || o.shipment.trackStatus}</div>}
                      </div>
                    )}
                    {o.settled && <div className="muted">On PO {o.settled.number}</div>}
                  </td>
                  <td className="num">{money(o.payout)}</td>
                  <td className="num">
                    {o.shipment?.fromYou ? (
                      <button className="btn btn-sm" onClick={() => openLabel(o._id)}>
                        <Icon name="down" size={14} /> Label
                      </button>
                    ) : !o.shipment && ["new", "packed"].includes(o.status) ? (
                      <span className="small muted">Awaiting booking</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="small muted" style={{ alignSelf: "center" }}>
            Page {page} of {pages}
          </span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

function Stock() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 400);
  const [list, setList] = useState(null);
  const [next, setNext] = useState(null);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState("");
  const load = (after) =>
    api
      .get("/seller-portal/products", { params: { q: dq || undefined, after } })
      .then((r) => {
        setList((cur) => (after ? [...(cur || []), ...r.data.products] : r.data.products));
        setNext(r.data.next);
      })
      .catch((e) => {
        toast(errMsg(e), "error");
        setList([]);
      });
  useEffect(() => {
    setList(null);
    load();
  }, [dq]);
  const save = async (v) => {
    const qty = Number(edits[v.id]);
    if (!Number.isInteger(qty) || qty < 0) return toast("Enter a whole number", "error");
    setSaving(v.id);
    try {
      await api.post("/seller-portal/products/stock", { variantId: v.id, quantity: qty });
      setList((cur) => cur.map((p) => ({ ...p, variants: p.variants.map((x) => (x.id === v.id ? { ...x, available: qty } : x)) })));
      setEdits((e) => {
        const n = { ...e };
        delete n[v.id];
        return n;
      });
      toast(`Stock of ${v.sku || "product"} set to ${qty} on the store`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setSaving("");
  };
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search your products by name or SKU" />
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        The quantity available on the marketplace store. Changing it here updates the store straight away.
      </p>
      {!list ? (
        <Spinner />
      ) : !list.length ? (
        <Empty title="No products found" text="Your products are those whose Vendor on the store is your brand." />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th className="num">Price</th>
                <th className="num">Available</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.flatMap((p) =>
                p.variants.map((v, i) => (
                  <tr key={v.id}>
                    <td>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {(v.image || p.image) && <img src={v.image || p.image} alt="" width={34} height={34} style={{ objectFit: "cover", borderRadius: 4, visibility: i && !v.image ? "hidden" : "visible" }} />}
                        <div>
                          <div className={i ? "small" : "strong"}>{i ? "" : p.title}</div>
                          {v.title && <div className="small muted">{v.title}</div>}
                          {!i && p.status !== "ACTIVE" && <span className="status status-draft">{String(p.status).toLowerCase()}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="small">{v.sku || "—"}</td>
                    <td className="num">{amount(v.price)}</td>
                    <td className="num">
                      <input type="number" min="0" step="1" style={{ width: 90, textAlign: "right" }} value={edits[v.id] ?? (v.available ?? "")} placeholder={v.available === null ? "—" : ""} onChange={(e) => setEdits({ ...edits, [v.id]: e.target.value })} />
                    </td>
                    <td className="num">
                      {edits[v.id] !== undefined && String(edits[v.id]) !== String(v.available) && (
                        <button className="btn btn-sm btn-primary" disabled={saving === v.id} onClick={() => save(v)}>
                          {saving === v.id ? "Saving…" : "Save"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={() => load(next)}>
            Load more
          </button>
        </div>
      )}
    </>
  );
}

function Pos() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api
      .get("/seller-portal/purchase-orders")
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  }, []);
  const show = (id) =>
    api
      .get(`/seller-portal/purchase-orders/${id}`)
      .then((r) => setOpen(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        On the 5th of each month a purchase order is raised for your orders delivered by the end of the previous month, at least 7 days ago and not returned. Deductions are already taken off it. Send your invoice for the PO amount; payment follows.
      </p>
      {!list ? (
        <Spinner />
      ) : !list.length ? (
        <Empty title="No purchase orders yet" />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table table-click">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Date</th>
                <th>For</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p._id} onClick={() => show(p._id)}>
                  <td className="link strong">{p.number}</td>
                  <td>{date(p.date)}</td>
                  <td className="small">{p.reference}</td>
                  <td className="small">{p.status === "billed" ? "Invoice received" : p.status === "cancelled" ? "Cancelled" : "Awaiting your invoice"}</td>
                  <td className="num">{money(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <PoView po={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PoView({ po, onClose }) {
  const b = po.buyer || {};
  return (
    <Modal
      open
      wide
      title={`Purchase order ${po.number}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
      }
    >
      <div className="print-area">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="strong">{b.name}</div>
            <div className="small muted">{[b.address?.street, b.address?.city, stateName(b.state), b.address?.pincode].filter(Boolean).join(", ")}</div>
            {b.gstin && <div className="small">GSTIN {b.gstin}</div>}
          </div>
          <div className="small" style={{ textAlign: "right" }}>
            <div>
              PO <strong>{po.number}</strong>
            </div>
            <div>Date {date(po.date)}</div>
            <div className="muted">{po.reference}</div>
          </div>
        </div>
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Qty</th>
              <th className="num">Rate</th>
              <th className="num">GST</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.lineItems.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.name}
                  {l.description && <div className="small muted">{l.description}</div>}
                </td>
                <td className="num">{l.quantity}</td>
                <td className="num">{amount(l.rate)}</td>
                <td className="num">{l.taxRate}%</td>
                <td className="num">{amount(l.amount ?? l.quantity * l.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <table className="table compact" style={{ width: "auto", minWidth: 260 }}>
            <tbody>
              <tr>
                <td>Sub total</td>
                <td className="num">{amount(po.subTotal)}</td>
              </tr>
              {po.cgst > 0 && (
                <tr>
                  <td>CGST</td>
                  <td className="num">{amount(po.cgst)}</td>
                </tr>
              )}
              {po.sgst > 0 && (
                <tr>
                  <td>SGST</td>
                  <td className="num">{amount(po.sgst)}</td>
                </tr>
              )}
              {po.igst > 0 && (
                <tr>
                  <td>IGST</td>
                  <td className="num">{amount(po.igst)}</td>
                </tr>
              )}
              {po.adjustment !== 0 && (
                <tr>
                  <td>Deductions / rounding</td>
                  <td className="num">{amount(po.adjustment)}</td>
                </tr>
              )}
              <tr className="row-total">
                <td>Total</td>
                <td className="num">{money(po.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {po.customerNotes && <p className="small" style={{ whiteSpace: "pre-wrap" }}>{po.customerNotes}</p>}
      </div>
    </Modal>
  );
}

function Penalties() {
  const [list, setList] = useState(null);
  useEffect(() => {
    api
      .get("/seller-portal/penalties")
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!list) return <Spinner />;
  if (!list.length) return <Empty title="No deductions" />;
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Reason</th>
            <th>Order</th>
            <th>Status</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p._id}>
              <td>{date(p.date)}</td>
              <td>{p.reason}</td>
              <td>{p.orderName || "—"}</td>
              <td className="small">{p.purchaseOrderNumber ? `Deducted on PO ${p.purchaseOrderNumber}` : "To be deducted from your next PO"}</td>
              <td className="num">{money(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
