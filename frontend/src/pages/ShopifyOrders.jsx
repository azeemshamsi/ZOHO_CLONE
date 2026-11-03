import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { stateName } from "../lib/constants";
import { PageHeader, Spinner, Empty, Modal, Field, SearchBox, useDebounced, toast } from "../components/ui";
import Icon from "../components/Icon";
import { useAuth } from "../lib/auth";

const TABS = [
  ["new", "New"],
  ["packed", "Packed"],
  ["ready_to_ship", "Ready to Ship"],
  ["shipped", "Shipped"],
  ["delivered", "Delivered"],
  ["rto", "RTO"],
  ["return_created", "Returns"],
  ["returned", "Returned"],
  ["cancelled", "Cancelled"],
  ["all", "All Orders"],
];
const STATUS_LABEL = Object.fromEntries(TABS);
const TRACK_LABEL = { pending: "Awaiting pickup", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered", rto: "RTO", cancelled: "Cancelled by courier" };
const FIN = { PAID: "Paid", PENDING: "Pending", PARTIALLY_PAID: "Partly paid", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Part refunded", VOIDED: "Voided", AUTHORIZED: "Authorized", EXPIRED: "Expired" };
const PAY = { cod: ["COD", "status-partially_paid"], prepaid: ["Prepaid", "status-paid"], partial: ["Partly paid", "status-sent"] };
const PayBadge = ({ o }) => <span className={`status ${(PAY[o.paymentMode] || PAY.prepaid)[1]}`}>{(PAY[o.paymentMode] || PAY.prepaid)[0]}</span>;
const PaySplit = ({ o }) =>
  o.paymentMode === "partial" ? (
    <div className="muted small">
      {money(o.prepaidAmount)} paid · {money(o.codAmount)} COD
    </div>
  ) : null;
const EMPTY_FILTERS = { q: "", from: "", to: "", payment: "", financial: "", state: "", courier: "", invoiced: "", tag: "", sort: "newest" };

const openPdf = async (url, body) => {
  const w = window.open("", "_blank");
  try {
    const r = body ? await api.post(url, body, { responseType: "blob" }) : await api.get(url, { responseType: "blob" });
    if (r.data.type === "application/json") {
      const j = JSON.parse(await r.data.text());
      if (j.url) {
        if (w) w.location = j.url;
        else window.open(j.url, "_blank");
        return;
      }
    }
    const blobUrl = URL.createObjectURL(r.data);
    if (w) w.location = blobUrl;
    else window.open(blobUrl, "_blank");
  } catch (e) {
    if (w) w.close();
    let m = errMsg(e);
    if (e?.response?.data instanceof Blob) m = JSON.parse(await e.response.data.text()).message || m;
    toast(m, "error");
  }
};

function ResultsModal({ results, title, onClose }) {
  if (!results) return null;
  const bad = results.filter((r) => r.error);
  const good = results.filter((r) => !r.error);
  const shipped = title === "Shipments" ? good.filter((r) => r.awb).map((r) => r.id) : [];
  const footer = (
    <>
      {shipped.length > 0 && (
        <>
          <button className="btn" onClick={() => openPdf("/shopify/orders/labels", { ids: shipped, format: "4x6" })}>Download label 4x6</button>
          <button className="btn" onClick={() => openPdf("/shopify/orders/labels", { ids: shipped, format: "a4" })}>Label A4</button>
        </>
      )}
      <button className="btn btn-primary" onClick={onClose}>Done</button>
    </>
  );
  return (
    <Modal open title={title} onClose={onClose} footer={footer}>
      <p>
        <strong>{good.length}</strong> done{bad.length ? <>, <strong className="text-red">{bad.length}</strong> couldn't be done</> : ""}.
      </p>
      <table className="table compact">
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className={r.error ? "text-red" : ""}>{r.error || [r.skipped ? "Already invoiced" : "", r.invoiceNumber, r.courierName, r.awb, r.charge != null ? money(r.charge) : "", r.text, r.warning].filter(Boolean).join(" · ") || "Done"}</td>
              {shipped.length > 0 && <td>{r.awb && <button className="btn btn-sm" onClick={() => openPdf(`/shopify/orders/${r.id}/label`)}>Label</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

const pkgText = (p) => (p ? `${p.packageName ? `${p.packageName} · ` : ""}${p.weight} kg, ${p.length}×${p.breadth}×${p.height} cm` : "");
const SERV = { true: ["Serviceable", "status-paid"], false: ["Not serviceable", "status-overdue"], null: ["Not checked", "status-draft"] };
const ServBadge = ({ v, note }) => {
  const [t, c] = SERV[String(v ?? null)];
  return (
    <span className={`status ${c}`} title={note || ""}>
      {t}
    </span>
  );
};
const ChargeCell = ({ r }) =>
  r.charge != null ? (
    <span title={r.breakdown ? `${r.breakdown.zoneName} · ${r.breakdown.weight} kg chargeable · freight ${r.breakdown.freight} + fuel ${r.breakdown.fuel} + COD ${r.breakdown.cod} + GST ${r.breakdown.gst}` : "From the courier's API"}>
      <strong>{money(r.charge)}</strong> <span className="muted small">{r.source === "api" ? "API" : "rate card"}</span>
    </span>
  ) : (
    <span className="muted small">No rate</span>
  );

// Flatten courier rows: an aggregator (Shiprocket) lists each of its couriers as its own choice.
const choicesOf = (rows) =>
  rows.flatMap((r) =>
    r.options?.length && r.serviceable !== false
      ? r.options.map((o) => ({ ...r, key: `${r.account}|${o.courierId}`, courierId: o.courierId, sub: o.name, charge: o.charge, source: "api", etd: o.etd, breakdown: null, serviceable: true }))
      : [{ ...r, key: r.account, courierId: "" }]
  );

// Live serviceability + expected charges for one order (read-only, in the order view).
function CourierRates({ id }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .post("/shopify/orders/quotes", { ids: [id] })
      .then((r) => setD(r.data.orders[0]))
      .catch((e) => setErr(errMsg(e)));
  }, [id]);
  if (err) return <p className="muted small">Courier charges: {err}</p>;
  if (!d) return <p className="muted small">Checking couriers for this pincode…</p>;
  if (d.error || d.needsPackage) return <p className="muted small">{d.error || "Its products have no package type — set one on the item (Items / Inventory), or enter the weight and size when booking, to see courier charges."}</p>;
  const rows = choicesOf(d.rows);
  if (!rows.length) return <p className="muted small">No active couriers. Add one in Store Settings → Couriers.</p>;
  return (
    <>
      <div className="muted small" style={{ margin: "4px 0" }}>
        To {d.pincode} {d.city} · {d.cod ? `COD ${money(d.codAmount)}` : "Prepaid"} · Package: {pkgText(d.pkg)}
      </div>
      <table className="table compact">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={r.serviceable === false ? "muted" : ""}>
              <td>
                {r.name}
                {r.sub && <span className="muted"> · {r.sub}</span>}
                {i === 0 && r.serviceable !== false && r.charge != null && <span className="pill pill-green" style={{ marginLeft: 6 }}>Cheapest</span>}
              </td>
              <td>
                <ServBadge v={r.serviceable} note={r.note} />
                {r.note && r.serviceable !== true && <div className="muted small">{r.note}</div>}
              </td>
              <td className="num">
                <ChargeCell r={r} />
              </td>
              <td className="muted small">{r.etd}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ShipModal({ ids, couriers, onClose, onDone }) {
  const active = couriers.filter((c) => c.active);
  const single = ids.length === 1;
  const [packages, setPackages] = useState([]);
  const [mode, setMode] = useState("auto"); // auto | <package type id> | manual
  const [manualPkg, setManualPkg] = useState({ weight: "", length: "", breadth: "", height: "" });
  const [quotes, setQuotes] = useState(null);
  const [checking, setChecking] = useState(false);
  const [pick, setPick] = useState(null); // { account, courierId, key }
  const [manual, setManual] = useState({ awb: "", courierName: "" });
  const [invoiceFirst, setInvoiceFirst] = useState(false);
  const [skipCheck, setSkipCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const manualOk = ["weight", "length", "breadth", "height"].every((k) => Number(manualPkg[k]) > 0);
  const pkgBody = mode === "auto" ? {} : mode === "manual" ? (manualOk ? Object.fromEntries(Object.entries(manualPkg).map(([k, v]) => [k, Number(v)])) : null) : { packageType: mode };
  const pkgKey = JSON.stringify(pkgBody);

  useEffect(() => {
    api.get("/shopify/package-types").then((r) => setPackages(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!pkgBody || !active.length) return;
    let live = true;
    setChecking(true);
    const t = setTimeout(
      () =>
        api
          .post("/shopify/orders/quotes", { ids: ids.slice(0, 50), pkg: pkgBody })
          .then((r) => {
            if (!live) return;
            setQuotes(r.data);
            const o = r.data.orders[0];
            if (single && mode === "auto" && o?.needsPackage) setMode("manual");
            if (single && mode === "auto" && o?.pkg) setManualPkg({ weight: o.pkg.weight, length: o.pkg.length, breadth: o.pkg.breadth, height: o.pkg.height });
            // Pre-select the cheapest courier that delivers there.
            const list = single ? choicesOf(o?.rows || []) : (r.data.summary || []).map((s) => ({ ...s, key: s.account, serviceable: s.serviceable + s.unknown > 0 ? true : false }));
            setPick((cur) => {
              if (cur && list.some((x) => x.key === cur.key && x.serviceable !== false)) return cur;
              const best = list.find((x) => x.serviceable !== false) || list[0];
              return best ? { account: best.account, courierId: best.courierId || "", key: best.key } : null;
            });
          })
          .catch((e) => live && toast(errMsg(e), "error"))
          .finally(() => live && setChecking(false)),
      mode === "manual" ? 600 : 0
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pkgKey]);

  const acc = active.find((c) => c._id === pick?.account);
  const order = single ? quotes?.orders?.[0] : null;
  const choices = single ? choicesOf(order?.rows || []) : [];
  const chosen = single ? choices.find((c) => c.key === pick?.key) : quotes?.summary?.find((s) => s.account === pick?.account);
  const blocked = single && chosen?.serviceable === false && !skipCheck;
  const needPkg = mode === "manual" && !manualOk;
  const autoMissing = !single && quotes?.orders?.filter((o) => o.needsPackage).length;

  const go = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/orders/ship", { ids, account: pick.account, pkg: pkgBody || {}, manual: { ...manual, courierId: pick.courierId || "" }, invoiceFirst, skipCheck });
      onDone(data.results);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      wide
      title={`Book shipment${ids.length > 1 ? ` for ${ids.length} orders` : ""}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !pick || needPkg || blocked || (acc?.carrier === "custom" && single && !manual.awb)} onClick={go}>
            {busy ? "Checking pincode & booking…" : chosen?.charge != null ? `Book · ${money(chosen.charge)}` : "Book Shipment"}
          </button>
        </>
      }
    >
      {!active.length ? (
        <p>
          No courier set up yet. <Link to="/shopify-settings#couriers">Add a courier</Link> (Shiprocket, Delhivery, Blue Dart, DTDC, Shadowfax or your own).
        </p>
      ) : (
        <div className="form-grid">
          <Field label="Package" hint={mode === "auto" ? (single ? (order?.pkg ? `From the products: ${pkgText(order.pkg)}` : order?.needsPackage ? "Its products have no package type — choose one or enter the size" : "") : "Each order uses its own products' package types") : ""}>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="auto">From the products' package types</option>
              {packages.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name} — {p.weight} kg, {p.length}×{p.breadth}×{p.height} cm
                </option>
              ))}
              <option value="manual">Enter weight and size</option>
            </select>
          </Field>
          {mode === "manual" && (
            <div className="row-4">
              {[
                ["weight", "Weight (kg)"],
                ["length", "Length (cm)"],
                ["breadth", "Breadth (cm)"],
                ["height", "Height (cm)"],
              ].map(([k, l]) => (
                <Field key={k} label={l} required>
                  <input type="number" step="0.01" min="0" value={manualPkg[k]} onChange={(e) => setManualPkg({ ...manualPkg, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
          )}
          {autoMissing > 0 && mode === "auto" && <p className="alert alert-warn">{autoMissing} of these orders have products without a package type — they won't be booked. Choose a package above to use it for all.</p>}

          <div className="label-sm">
            Couriers {single && order ? `to ${order.pincode} ${order.city} · ${order.cod ? `COD ${money(order.codAmount)}` : "Prepaid"}` : ""} {checking && <span className="muted">· checking live…</span>}
          </div>
          {needPkg ? (
            <p className="muted small">Enter the weight and size to check couriers and rates.</p>
          ) : !quotes ? (
            <Spinner />
          ) : single ? (
            <table className="table compact table-click">
              <thead>
                <tr>
                  <th></th>
                  <th>Courier</th>
                  <th>Pincode</th>
                  <th className="num">Expected charge</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {choices.map((r, i) => (
                  <tr key={r.key} className={r.serviceable === false ? "muted" : ""} onClick={() => setPick({ account: r.account, courierId: r.courierId, key: r.key })}>
                    <td>
                      <input type="radio" readOnly checked={pick?.key === r.key} />
                    </td>
                    <td>
                      {r.name}
                      {r.sub && <span className="muted"> · {r.sub}</span>}
                      {r.test && <span className="muted"> (test)</span>}
                      {i === 0 && r.serviceable !== false && r.charge != null && <span className="pill pill-green" style={{ marginLeft: 6 }}>Cheapest</span>}
                    </td>
                    <td>
                      <ServBadge v={r.serviceable} note={r.note} />
                      {r.note && r.serviceable !== true && <div className="muted small">{r.note}</div>}
                    </td>
                    <td className="num">
                      <ChargeCell r={r} />
                    </td>
                    <td className="muted small">{r.etd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="table compact table-click">
              <thead>
                <tr>
                  <th></th>
                  <th>Courier</th>
                  <th>Delivers to</th>
                  <th className="num">Expected total</th>
                </tr>
              </thead>
              <tbody>
                {quotes.summary.map((s) => (
                  <tr key={s.account} onClick={() => setPick({ account: s.account, courierId: "", key: s.account })}>
                    <td>
                      <input type="radio" readOnly checked={pick?.account === s.account} />
                    </td>
                    <td>{s.name}</td>
                    <td>
                      {s.serviceable} of {quotes.orders.length}
                      {s.unknown ? <span className="muted"> · {s.unknown} not checked</span> : ""}
                      {s.notServiceable.length > 0 && <div className="text-red small">Can't deliver: {s.notServiceable.slice(0, 8).join(", ")}{s.notServiceable.length > 8 ? "…" : ""}</div>}
                    </td>
                    <td className="num">{s.priced ? <>{money(s.total)} <span className="muted small">({s.priced} priced)</span></> : <span className="muted small">No rate</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!single && ids.length > 50 && <p className="muted small">Rates are shown for the first 50 orders; every order's pincode is still checked when it's booked.</p>}
          {!single && <p className="muted small">Each order's pincode is checked live when it's booked; orders the courier can't deliver to are skipped and listed.</p>}
          {single && chosen?.serviceable === false && (
            <label className="check">
              <input type="checkbox" checked={skipCheck} onChange={(e) => setSkipCheck(e.target.checked)} /> Book anyway (the courier says it doesn't deliver here)
            </label>
          )}

          {acc?.carrier === "custom" &&
            (single ? (
              <div className="row-2">
                <Field label="AWB / Tracking number" required>
                  <input value={manual.awb} onChange={(e) => setManual({ ...manual, awb: e.target.value })} />
                </Field>
                <Field label="Courier name" hint={`Defaults to ${acc.name}`}>
                  <input value={manual.courierName} onChange={(e) => setManual({ ...manual, courierName: e.target.value })} />
                </Field>
              </div>
            ) : (
              <p className="alert alert-warn">Custom couriers need an AWB for each order — book them one at a time.</p>
            ))}
          <label className="check">
            <input type="checkbox" checked={invoiceFirst} onChange={(e) => setInvoiceFirst(e.target.checked)} /> Also create the invoice (optional — its number then goes on the shipment)
          </label>
        </div>
      )}
    </Modal>
  );
}

function OrderModal({ id, couriers, onClose, onChanged, onShip }) {
  const [o, setO] = useState(null);
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState("");
  const load = () =>
    api.get(`/shopify/orders/${id}`).then((r) => {
      setO(r.data);
      setRemarks(r.data.remarks || "");
    });
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [id]);
  const act = async (fn, msg) => {
    setBusy(true);
    try {
      const r = await fn();
      const res = r?.data?.results?.[0];
      if (res?.error) toast(res.error, "error");
      else if (msg) toast(msg);
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  if (!o) return <Modal open title="Order" onClose={onClose}><Spinner /></Modal>;
  const a = o.shippingAddress || {};
  const sh = o.shipment || {};
  const accName = couriers.find((c) => c._id === sh.account)?.name;
  return (
    <Modal
      open
      wide
      title={`Order ${o.name}`}
      onClose={onClose}
      footer={
        <div className="order-actions">
          {!o.invoice && o.status !== "cancelled" && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.post("/shopify/orders/invoice", { ids: [o._id] }), "Invoice created")}>
              Create Invoice
            </button>
          )}
          {["new", "packed"].includes(o.status) && (
            <button className="btn" disabled={busy} onClick={() => onShip([o._id])}>
              Book Shipment
            </button>
          )}
          {o.status === "new" && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post("/shopify/orders/status", { ids: [o._id], status: "packed" }), "Marked packed")}>
              Mark Packed
            </button>
          )}
          {sh.awb && (
            <button className="btn" onClick={() => openPdf(`/shopify/orders/${o._id}/label`)}>
              Label
            </button>
          )}
          {sh.awb && sh.account && !["delivered", "rto", "cancelled"].includes(o.status) && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post("/shopify/orders/track", { ids: [o._id] }), "Tracking updated")}>
              Refresh Tracking
            </button>
          )}
          {["shipped", "delivered"].includes(o.status) && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post("/shopify/orders/return", { ids: [o._id], action: "create", note: window.prompt("Reason for the return (optional)") || "" }), "Return created")}>
              Mark Return Created
            </button>
          )}
          {["rto", "return_created", "shipped", "delivered"].includes(o.status) && (
            <button className="btn" disabled={busy} onClick={() => window.confirm(`Close the return for ${o.name}? Do this when the parcel is back with you.`) && act(() => api.post("/shopify/orders/return", { ids: [o._id], action: "close" }), "Return closed")}>
              Mark Return Closed
            </button>
          )}
          {sh.awb && o.status === "ready_to_ship" && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => window.confirm(`Cancel shipment ${sh.awb}?`) && act(() => api.post(`/shopify/orders/${o._id}/cancel-shipment`), "Shipment cancelled")}>
              Cancel Shipment
            </button>
          )}
        </div>
      }
    >
      <div className="order-head">
        <div>
          <span className={`status ship-${o.status}`}>{STATUS_LABEL[o.status]}</span> <PayBadge o={o} /> <span className="muted small">{FIN[o.financialStatus] || o.financialStatus}{o.paymentMode === "partial" ? ` · ${money(o.prepaidAmount)} paid online, ${money(o.codAmount)} to collect on delivery` : o.paymentMode === "cod" ? ` · collect ${money(o.codAmount || o.total)}` : ""}</span>
        </div>
        <div className="muted small">{new Date(o.orderDate).toLocaleString("en-IN")}</div>
      </div>
      {o.status === "returned" && <div className="alert alert-info">Returned{o.returnedAt ? ` on ${date(o.returnedAt)}` : ""}{o.returnNote ? ` · ${o.returnNote}` : ""}</div>}
      {o.cancelledAt && <div className="alert alert-error">Cancelled in Shopify on {date(o.cancelledAt)}{o.cancelReason ? ` (${o.cancelReason.toLowerCase()})` : ""}</div>}
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div>
          <div className="label-sm">Ship to</div>
          <strong>{a.name || o.customer?.name}</strong>
          <div>{[a.address1, a.address2].filter(Boolean).join(", ")}</div>
          <div>
            {a.city}, {a.province || stateName(a.state)} {a.zip}
          </div>
          <div>{a.phone || o.customer?.phone}</div>
          {o.customer?.email && <div className="muted">{o.customer.email}</div>}
        </div>
        <div>
          <div className="label-sm">Invoice</div>
          {o.invoice ? <Link to={`/invoices/${o.invoice}`}>{o.invoiceNumber}</Link> : <span className="muted">Not invoiced{o.invoiceError ? ` — ${o.invoiceError}` : ""}</span>}
          <div className="label-sm" style={{ marginTop: 10 }}>
            Shipment
          </div>
          {sh.awb ? (
            <>
              <div>
                {sh.courierName}
                {accName && accName !== sh.courierName ? <span className="muted"> via {accName}</span> : ""}
              </div>
              <div>
                AWB{" "}
                {sh.trackingUrl ? (
                  <a href={sh.trackingUrl} target="_blank" rel="noreferrer">
                    {sh.awb}
                  </a>
                ) : (
                  <strong>{sh.awb}</strong>
                )}
              </div>
              {sh.trackStatus && <div className="muted small">{TRACK_LABEL[sh.trackStatus] || sh.trackStatus}{sh.trackedAt ? ` · checked ${new Date(sh.trackedAt).toLocaleString("en-IN")}` : ""}</div>}
              {sh.shopifyFulfilled && <div className="muted small">Marked fulfilled in Shopify</div>}
            </>
          ) : (
            <span className="muted">Not booked{sh.error ? ` — ${sh.error}` : ""}</span>
          )}
          {sh.awb && sh.charge != null && <div className="muted small">Expected charge {money(sh.charge)} ({sh.chargeSource === "api" ? "API" : "rate card"}){sh.packageName ? ` · ${sh.packageName}` : ""}</div>}
        </div>
      </div>
      {!sh.awb && ["new", "packed"].includes(o.status) && (
        <>
          <div className="label-sm" style={{ marginTop: 14 }}>
            Courier charges (live)
          </div>
          <CourierRates id={o._id} />
        </>
      )}
      <table className="table compact" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Item</th>
            <th>HSN · GST in OrdexaGo</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l) => (
            <tr key={l.lineId} className={l.quantity ? "" : "muted"}>
              <td>
                {l.image && <img src={l.image} alt="" className="ship-thumb" style={{ float: "left", marginRight: 8 }} />}
                {l.title}
                {l.variantTitle && <span className="muted"> — {l.variantTitle}</span>}
                {l.sku && <div className="muted small">SKU {l.sku}</div>}
              </td>
              <td>
                {l.item ? (
                  <Link to={`/items/${l.item._id}/edit`} title={l.item.reviewNote}>
                    {l.item.hsnSac || "No HSN"} · {l.item.taxRate}%{l.item.needsReview && <span className="pill pill-amber" style={{ marginLeft: 6 }}>Check</span>}
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
                {l.item?.reviewNote && <div className="muted small">{l.item.reviewNote}</div>}
                {l.stock && l.item?.trackInventory && (
                  <div className="small">
                    Stock {l.stock.onHand}
                    {l.stock.racks.length > 0 && <> · pick from <b>{l.stock.racks.join(", ")}</b></>}
                    {l.stock.unassigned > 0 && <span className="muted"> · {l.stock.unassigned} not on a rack</span>}
                  </div>
                )}
              </td>
              <td className="num">{l.quantity}</td>
              <td className="num">{money(l.unitPrice)}</td>
              <td className="num">
                {money(l.total)}
                {l.discount > 0 && <div className="muted small">−{money(l.discount)} disc.</div>}
              </td>
            </tr>
          ))}
          {o.shippingTotal > 0 && (
            <tr>
              <td colSpan={4}>Shipping</td>
              <td className="num">{money(o.shippingTotal)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={4}>
              <strong>Total</strong> <span className="muted small">(GST inclusive)</span>
            </td>
            <td className="num">
              <strong>{money(o.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      {sh.events?.length > 0 && (
        <>
          <div className="label-sm" style={{ marginTop: 14 }}>
            Tracking
          </div>
          <ul className="track-list">
            {sh.events.map((e, i) => (
              <li key={i}>
                <span className="muted small">{new Date(e.at).toLocaleString("en-IN")}</span> {e.status}
                {e.location ? <span className="muted"> · {e.location}</span> : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {(o.note || o.tags?.length > 0) && (
        <p className="muted small" style={{ marginTop: 10 }}>
          {o.note && <>Note: {o.note} </>}
          {o.tags?.length > 0 && <>Tags: {o.tags.join(", ")}</>}
        </p>
      )}
      <Field label="Remarks (only in OrdexaGo)">
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} onBlur={() => remarks !== (o.remarks || "") && api.put(`/shopify/orders/${o._id}/remarks`, { remarks }).then(() => toast("Remarks saved"))} />
      </Field>
    </Modal>
  );
}

function ReviewItems({ items, onClose, onChanged }) {
  return (
    <Modal open wide title="Items to check" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p className="muted small">These items were created from Shopify orders. OrdexaGo corrected the HSN or GST rate using your category rules, or couldn't tell the category. Open an item to fix it, or mark it checked.</p>
      <table className="table compact">
        <thead>
          <tr>
            <th>Item</th>
            <th>HSN</th>
            <th className="num">GST</th>
            <th>What happened</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i._id}>
              <td>
                <Link to={`/items/${i._id}/edit`}>{i.name}</Link>
                {i.sku && <div className="muted small">{i.sku}</div>}
              </td>
              <td>{i.hsnSac || <span className="text-red">Missing</span>}</td>
              <td className="num">{i.taxRate}%</td>
              <td className="small">{i.reviewNote}</td>
              <td>
                <button className="btn btn-sm" onClick={() => api.post(`/shopify/items/${i._id}/reviewed`).then(onChanged)}>
                  Looks right
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function ShopifyOrders() {
  const { organization, organizations } = useAuth();
  const companyName = (id) => (organizations || []).find((c) => String(c._id) === String(id))?.name || "other company";
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "new";
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [store, setStore] = useState(null);
  const [couriers, setCouriers] = useState([]);
  const [facets, setFacets] = useState({ states: [], tags: [], financial: [] });
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [ship, setShip] = useState(null);
  const [view, setView] = useState(null);
  const [review, setReview] = useState([]);
  const [showReview, setShowReview] = useState(false);
  const q = useDebounced(filters.q, 300);
  const poll = useRef();
  const nav = useNavigate();

  const query = useMemo(() => {
    const p = { status: tab, page, limit: 50 };
    for (const [k, v] of Object.entries({ ...filters, q })) if (v) p[k] = v;
    return p;
  }, [tab, page, filters, q]);

  const load = () => api.get("/shopify/orders", { params: query }).then((r) => setData(r.data));
  const loadReview = () => api.get("/shopify/items/review").then((r) => setReview(r.data));
  const loadStore = () =>
    api.get("/shopify/store").then((r) => {
      setStore(r.data);
      return r.data;
    });

  useEffect(() => {
    loadStore();
    api.get("/shopify/couriers").then((r) => setCouriers(r.data));
    api.get("/shopify/orders/facets").then((r) => setFacets(r.data));
    loadReview();
    return () => clearTimeout(poll.current);
  }, []);
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    setSel(new Set());
  }, [query]);

  const watchSync = () => {
    poll.current = setTimeout(async () => {
      const s = await loadStore();
      if (s.sync?.running) watchSync();
      else {
        if (s.sync?.error) toast(`Sync failed: ${s.sync.error}`, "error");
        else toast(`Synced: ${s.sync.created} new, ${s.sync.updated} updated`);
        load();
        loadReview();
        api.get("/shopify/orders/facets").then((r) => setFacets(r.data));
      }
    }, 1200);
  };
  const sync = async () => {
    try {
      await api.post("/shopify/sync");
      setStore({ ...store, sync: { ...(store.sync || {}), running: true } });
      watchSync();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const setTab = (t) => {
    setParams(t === "new" ? {} : { tab: t });
    setPage(1);
  };
  const setF = (k) => (e) => {
    setFilters({ ...filters, [k]: e.target.value });
    setPage(1);
  };
  const activeFilters = Object.entries(filters).filter(([k, v]) => v && k !== "q" && !(k === "sort" && v === "newest")).length;

  const ids = [...sel];
  const rows = data?.rows || [];
  const toggleAll = () => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((r) => r._id)));
  const toggle = (id) => {
    const s = new Set(sel);
    s.has(id) ? s.delete(id) : s.add(id);
    setSel(s);
  };
  const bulk = async (path, body, title) => {
    setBusy(true);
    try {
      const { data: d } = await api.post(path, body);
      setResults({ title, results: d.results });
      load();
      loadReview();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };

  if (store && !store.connected && !store.shop)
    return (
      <>
        <PageHeader title="Store" />
        <Empty icon="bag" title="Connect your Shopify store" text="Orders sync automatically, products become items with checked HSN and GST, and you can invoice and ship orders in one click." action={<Link className="btn btn-primary" to="/shopify-settings">Connect Shopify</Link>} />
      </>
    );

  const sync_ = store?.sync || {};
  return (
    <>
      <PageHeader title="Store" subtitle={store?.shopName ? `${store.shopName}${store.shared ? ` (shared from ${store.ownerName}) · invoices go to ${organization?.name}` : ""} · ${sync_.running ? "Syncing…" : store.lastSyncAt ? `Last synced ${new Date(store.lastSyncAt).toLocaleString("en-IN")}` : "Not synced yet"}${store.autoSync ? " · syncs every 15 min" : ""}` : ""}>
        <a className="btn" href={`/api/shopify/orders/export?${new URLSearchParams({ ...query, page: "" })}`} onClick={(e) => {
          e.preventDefault();
          api.get("/shopify/orders/export", { params: query, responseType: "blob" }).then((r) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(r.data);
            a.download = "shopify-orders.csv";
            a.click();
          });
        }}>
          Export
        </a>
        <Link className="btn" to="/returns-scan">
          Scan Returns
        </Link>
        <Link className="btn" to="/shopify-settings">
          <Icon name="settings" size={16} /> Settings
        </Link>
        <button className="btn btn-primary" disabled={sync_.running || !store?.connected} onClick={sync}>
          {sync_.running ? `Syncing… ${sync_.fetched || 0}` : "Sync Orders"}
        </button>
      </PageHeader>

      {store && !store.connected && <div className="alert alert-error" style={{ marginBottom: 12 }}>Shopify isn't connected. {sync_.error && <>Last error: {sync_.error}. </>}<Link to="/shopify-settings">Check the connection</Link></div>}
      {review.length > 0 && (
        <div className="alert alert-warn" style={{ marginBottom: 12, marginTop: 0 }}>
          {review.length} item{review.length === 1 ? "" : "s"} created from Shopify had the HSN or GST rate corrected, or need a check.{" "}
          <button className="link-btn" onClick={() => setShowReview(true)}>
            Review items
          </button>
        </div>
      )}

      <div className="tabs ship-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {l} <span className="tab-count">{data?.counts?.[k] ?? ""}</span>
          </button>
        ))}
      </div>

      <div className="card flush">
        <div className="filter-bar">
          <SearchBox value={filters.q} onChange={(v) => setFilters({ ...filters, q: v })} placeholder="Order no, customer, phone, AWB, SKU, pincode…" />
          <input type="date" value={filters.from} onChange={setF("from")} title="From" />
          <span className="muted">to</span>
          <input type="date" value={filters.to} onChange={setF("to")} title="To" />
          <select value={filters.payment} onChange={setF("payment")}>
            <option value="">All payment types</option>
            <option value="cod">COD</option>
            <option value="prepaid">Prepaid</option>
            <option value="partial">Partly paid</option>
          </select>
          <button className={`btn btn-sm ${showFilters || activeFilters ? "btn-active" : ""}`} onClick={() => setShowFilters(!showFilters)}>
            More filters{activeFilters ? ` (${activeFilters})` : ""}
          </button>
          {(activeFilters > 0 || filters.q) && (
            <button className="link-btn small" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear
            </button>
          )}
        </div>
        {showFilters && (
          <div className="filter-bar more">
            <select value={filters.financial} onChange={setF("financial")}>
              <option value="">Any payment status</option>
              {facets.financial.map((f) => (
                <option key={f} value={f}>
                  {FIN[f] || f}
                </option>
              ))}
            </select>
            <select value={filters.state} onChange={setF("state")}>
              <option value="">All states</option>
              {facets.states.map((s) => (
                <option key={s} value={s}>
                  {stateName(s) || s}
                </option>
              ))}
            </select>
            <select value={filters.courier} onChange={setF("courier")}>
              <option value="">All couriers</option>
              {couriers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={filters.invoiced} onChange={setF("invoiced")}>
              <option value="">Invoiced or not</option>
              <option value="yes">Invoiced</option>
              <option value="no">Not invoiced</option>
            </select>
            <select value={filters.tag} onChange={setF("tag")}>
              <option value="">Any tag</option>
              {facets.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select value={filters.sort} onChange={setF("sort")}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amount">Highest amount</option>
            </select>
          </div>
        )}

        {sel.size > 0 && (
          <div className="bulk-bar">
            <strong>{sel.size} selected</strong>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => bulk("/shopify/orders/invoice", { ids }, "Invoices")}>
              Generate Invoices
            </button>
            {["new", "packed", "all"].includes(tab) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => setShip(ids)}>
                Book Shipment
              </button>
            )}
            {["new", "all"].includes(tab) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/status", { ids, status: "packed" }, "Mark packed")}>
                Mark Packed
              </button>
            )}
            {["ready_to_ship", "shipped", "delivered", "rto", "all"].includes(tab) && (
              <>
                <button className="btn btn-sm" disabled={busy} onClick={() => openPdf("/shopify/orders/labels", { ids, format: "4x6" })}>
                  Labels 4x6
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => openPdf("/shopify/orders/labels", { ids, format: "a4" })}>
                  Labels A4
                </button>
              </>
            )}
            {["ready_to_ship", "shipped", "all"].includes(tab) && (
              <>
                <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/track", { ids }, "Tracking")}>
                  Refresh Tracking
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/status", { ids, status: "shipped" }, "Mark shipped")}>
                  Mark Shipped
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/status", { ids, status: "delivered" }, "Mark delivered")}>
                  Mark Delivered
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/status", { ids, status: "rto" }, "Mark RTO")}>
                  Mark RTO
                </button>
              </>
            )}
            {["shipped", "delivered", "all"].includes(tab) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/return", { ids, action: "create" }, "Returns created")}>
                Mark Return Created
              </button>
            )}
            {["rto", "return_created", "shipped", "delivered", "all"].includes(tab) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/return", { ids, action: "close" }, "Returns closed")}>
                Mark Return Closed
              </button>
            )}
            {tab === "packed" && (
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => bulk("/shopify/orders/status", { ids, status: "new" }, "Move to New")}>
                Move to New
              </button>
            )}
          </div>
        )}

        {!data ? (
          <Spinner />
        ) : !rows.length ? (
          <div className="empty-row muted">{data.counts.all ? "No orders match." : store?.connected ? "No orders yet — click Sync Orders." : "No orders."}</div>
        ) : (
          <table className="table table-click ship-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={sel.size === rows.length} onChange={toggleAll} />
                </th>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Payment</th>
                <th>{tab === "new" || tab === "packed" ? "Destination" : "Shipment"}</th>
                <th>Invoice</th>
                {tab === "all" && <th>Status</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const items = (o.lines || []).filter((l) => l.quantity > 0);
                const sh = o.shipment || {};
                return (
                  <tr key={o._id} onClick={() => setView(o._id)} className={sel.has(o._id) ? "selected" : ""}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(o._id)} onChange={() => toggle(o._id)} />
                    </td>
                    <td>
                      <strong>{o.name}</strong>
                      <div className="muted small">{new Date(o.orderDate).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                    </td>
                    <td>
                      {o.customer?.name}
                      <div className="muted small">{o.customer?.phone}</div>
                    </td>
                    <td className="small">
                      <div className="ship-items">
                        {items[0]?.image ? <img src={items[0].image} alt="" className="ship-thumb" loading="lazy" /> : <div className="ship-thumb empty" />}
                        <div>
                          {items.slice(0, 2).map((l, i) => (
                            <div key={i} className="ellipsis">
                              {l.quantity} × {l.title}
                              {l.variantTitle ? ` (${l.variantTitle})` : ""}
                              {l.sku && <span className="muted"> · {l.sku}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                      {items.length > 2 && <div className="muted">+{items.length - 2} more</div>}
                    </td>
                    <td>
                      <strong>{money(o.total)}</strong>
                      <div>
                        <PayBadge o={o} />
                      </div>
                      <PaySplit o={o} />
                    </td>
                    <td className="small">
                      {sh.awb ? (
                        <>
                          <div>{sh.courierName}</div>
                          {sh.trackingUrl ? (
                            <a href={sh.trackingUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                              {sh.awb}
                            </a>
                          ) : (
                            <div>{sh.awb}</div>
                          )}
                          {sh.trackStatus && <div className="muted">{TRACK_LABEL[sh.trackStatus] || sh.trackStatus}</div>}
                        </>
                      ) : (
                        <>
                          {o.shippingAddress?.city}
                          <div className="muted">
                            {o.shippingAddress?.province || stateName(o.shippingAddress?.state)} {o.shippingAddress?.zip}
                          </div>
                        </>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {o.invoice ? (
                        o.invoiceOrg && String(o.invoiceOrg) !== String(organization?._id) ? (
                          <span title="Invoiced in your other company">{o.invoiceNumber} <span className="muted small">({companyName(o.invoiceOrg)})</span></span>
                        ) : (
                          <Link to={`/invoices/${o.invoice}`}>{o.invoiceNumber}</Link>
                        )
                      ) : o.status !== "cancelled" ? (
                        <button className="btn btn-sm" disabled={busy} onClick={() => bulk("/shopify/orders/invoice", { ids: [o._id] }, "Invoice")}>
                          Invoice
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {tab === "all" && (
                      <td>
                        <span className={`status ship-${o.status}`}>{STATUS_LABEL[o.status]}</span>
                      </td>
                    )}
                    <td onClick={(e) => e.stopPropagation()} className="row-btns">
                      {["new", "packed"].includes(o.status) && (
                        <button className="btn btn-sm" onClick={() => setShip([o._id])}>
                          Ship
                        </button>
                      )}
                      {sh.awb && (
                        <button className="btn btn-sm" onClick={() => openPdf(`/shopify/orders/${o._id}/label`)}>
                          Label
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && data.total > data.limit && (
          <div className="pager">
            <span className="muted small">
              {(data.page - 1) * data.limit + 1}–{Math.min(data.total, data.page * data.limit)} of {data.total}
            </span>
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn btn-sm" disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </div>

      {ship && (
        <ShipModal
          ids={ship}
          couriers={couriers}
          store={store}
          onClose={() => setShip(null)}
          onDone={(r) => {
            setShip(null);
            setResults({ title: "Shipments", results: r });
            load();
          }}
        />
      )}
      {results && <ResultsModal {...results} onClose={() => setResults(null)} />}
      {view && <OrderModal id={view} couriers={couriers} onClose={() => setView(null)} onChanged={load} onShip={(i) => setShip(i)} />}
      {showReview && <ReviewItems items={review} onClose={() => setShowReview(false)} onChanged={loadReview} />}
      {void nav}
    </>
  );
}
