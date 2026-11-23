import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { stateName } from "../lib/constants";
import {
  PageHeader,
  Spinner,
  Empty,
  Modal,
  Field,
  SearchBox,
  useDebounced,
  toast,
} from "../components/ui";
import Icon from "../components/Icon";
import { breakdownText } from "../components/rates";
import SearchSelect from "../components/SearchSelect";
import PackagePicker, { packageOptions } from "../components/PackagePicker";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import PaymentProofs from "../components/PaymentProofs";

const TABS = [
  ["new", "New"],
  ["packed", "Packed"],
  ["ready_to_ship", "Ready to Ship"],
  ["awb_scanned", "AWB Scanned"],
  ["shipped", "Shipped"],
  ["delivered", "Delivered"],
  ["rto", "RTO"],
  ["return_created", "Returns"],
  ["returned", "Returned"],
  ["cancelled", "Cancelled"],
  ["all", "All Orders"],
];
const STATUS_LABEL = Object.fromEntries(TABS);
const TRACK_LABEL = {
  pending: "Awaiting pickup",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  rto: "RTO",
  cancelled: "Cancelled by courier",
};
const FIN = {
  PAID: "Paid",
  PENDING: "Pending",
  PARTIALLY_PAID: "Partly paid",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Part refunded",
  VOIDED: "Voided",
  AUTHORIZED: "Authorized",
  EXPIRED: "Expired",
};
const PAY = {
  cod: ["COD", "status-partially_paid"],
  prepaid: ["Prepaid", "status-paid"],
  partial: ["Partly paid", "status-sent"],
};
const PayBadge = ({ o }) => (
  <span className={`status ${(PAY[o.paymentMode] || PAY.prepaid)[1]}`}>
    {(PAY[o.paymentMode] || PAY.prepaid)[0]}
  </span>
);
const PaySplit = ({ o }) =>
  o.paymentMode === "partial" ? (
    <div className="muted small">
      {money(o.prepaidAmount)} paid · {money(o.codAmount)} COD
    </div>
  ) : null;
const EMPTY_FILTERS = {
  channel: "",
  q: "",
  from: "",
  to: "",
  payment: "",
  financial: "",
  state: "",
  courier: "",
  invoiced: "",
  tag: "",
  seller: "",
  sort: "newest",
};

const openPdf = async (url, body) => {
  const w = window.open("", "_blank");
  try {
    const r = body
      ? await api.post(url, body, { responseType: "blob" })
      : await api.get(url, { responseType: "blob" });
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
    if (e?.response?.data instanceof Blob)
      m = JSON.parse(await e.response.data.text()).message || m;
    toast(m, "error");
  }
};

function ResultsModal({ results, title, onClose }) {
  if (!results) return null;
  const bad = results.filter((r) => r.error);
  const good = results.filter((r) => !r.error);
  const shipped =
    title === "Shipments" ? good.filter((r) => r.awb).map((r) => r.id) : [];
  const footer = (
    <>
      {shipped.length > 0 && (
        <>
          <button
            className="btn"
            onClick={() =>
              openPdf("/shopify/orders/labels", { ids: shipped, format: "4x6" })
            }
          >
            Download label 4x6
          </button>
          <button
            className="btn"
            onClick={() =>
              openPdf("/shopify/orders/labels", { ids: shipped, format: "a4" })
            }
          >
            Label A4
          </button>
        </>
      )}
      <button className="btn btn-primary" onClick={onClose}>
        Done
      </button>
    </>
  );
  return (
    <Modal open title={title} onClose={onClose} footer={footer}>
      <p>
        <strong>{good.length}</strong> done
        {bad.length ? (
          <>
            , <strong className="text-red">{bad.length}</strong> couldn't be
            done
          </>
        ) : (
          ""
        )}
        .
      </p>
      <table className="table compact">
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className={r.error ? "text-red" : ""}>
                {r.error ||
                  [
                    r.skipped ? "Already invoiced" : "",
                    r.invoiceNumber,
                    r.courierName,
                    r.awb,
                    r.charge != null ? money(r.charge) : "",
                    r.text,
                    r.warning,
                  ]
                    .filter(Boolean)
                    .join(" · ") ||
                  "Done"}
              </td>
              {shipped.length > 0 && (
                <td>
                  {r.awb && (
                    <button
                      className="btn btn-sm"
                      onClick={() => openPdf(`/shopify/orders/${r.id}/label`)}
                    >
                      Label
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

const pkgText = (p) =>
  p
    ? `${p.packageName ? `${p.packageName} · ` : ""}${p.weight} kg, ${p.length}×${p.breadth}×${p.height} cm`
    : "";
const SERV = {
  true: ["Serviceable", "status-paid"],
  false: ["Not serviceable", "status-overdue"],
  null: ["Not checked", "status-draft"],
};
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
    <span title={breakdownText(r)} style={{ cursor: "help" }}>
      <strong>{money(r.charge)}</strong>{" "}
      <span className="muted small">
        {r.source === "api" ? "API" : "rate card"}
      </span>
      {r.edl && (
        <span className="pill pill-amber" style={{ marginLeft: 4 }}>
          EDL
        </span>
      )}
      {(r.zone || r.chargeableWeight) && (
        <div className="muted small">
          {r.zone ? `Zone ${r.zone} · ` : ""}
          {r.chargeableWeight} kg
        </div>
      )}
    </span>
  ) : (
    <span className="muted small">No rate{r.edl ? " · EDL" : ""}</span>
  );

// Flatten courier rows: an aggregator (Shiprocket) lists each of its couriers as its own choice.
const choicesOf = (rows) =>
  rows.flatMap((r) =>
    r.options?.length && r.serviceable !== false
      ? r.options.map((o) => ({
          ...r,
          key: `${r.account}|${o.courierId}`,
          courierId: o.courierId,
          sub: o.name,
          charge: o.charge,
          source: "api",
          etd: o.etd,
          breakdown: null,
          serviceable: true,
        }))
      : [{ ...r, key: r.account, courierId: "" }],
  );

// Each product's package type, settable right here so its next orders book faster.
function LinePackages({ lines, packages, onChanged }) {
  const set = async (l, packageType) => {
    try {
      await api.post("/shopify/package-types/assign", {
        items: [l.item],
        packageType: packageType || null,
      });
      toast(
        packageType
          ? `Package type set on ${l.sku || l.title}`
          : "Package type removed",
      );
      onChanged?.();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const list = (lines || []).filter((l) => l.item);
  if (!list.length) return null;
  return (
    <table className="table compact">
      <tbody>
        {list.map((l) => (
          <tr key={l.item + l.sku}>
            <td style={{ width: "45%" }}>
              <strong>{l.sku || "—"}</strong>{" "}
              <span className="muted small">{l.title}</span>
              {l.quantity > 1 && (
                <span className="muted small"> × {l.quantity}</span>
              )}
            </td>
            <td>
              <PackagePicker
                value={l.packageType}
                packages={packages}
                onChange={(v) => v !== (l.packageType || "") && set(l, v)}
                placeholder="No package type — search to set one"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Save the weight and size typed when booking as a package type, and give it to the order's product.
function SaveAsPackage({ dims, lines, onSaved }) {
  const prods = (lines || []).filter((l) => l.item);
  const oneProduct = prods.length === 1;
  const [name, setName] = useState(
    prods
      .map((l) => l.sku || l.title)
      .join(" + ")
      .slice(0, 80),
  );
  const [assign, setAssign] = useState(oneProduct);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/package-types", {
        name,
        ...Object.fromEntries(
          Object.entries(dims).map(([k, v]) => [k, Number(v)]),
        ),
        items: assign ? prods.map((l) => l.item) : [],
      });
      toast(
        `Package type “${data.name}” saved${data.assigned ? ` and set on ${prods.map((l) => l.sku || l.title).join(", ")}` : ""}`,
      );
      onSaved(data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <div
      className="card"
      style={{ padding: 10, background: "var(--bg-soft, #f8fafc)" }}
    >
      <div
        style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}
      >
        <Field label="Save as package type">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            style={{ minWidth: 220 }}
          />
        </Field>
        <button
          type="button"
          className="btn"
          disabled={busy || !name.trim()}
          onClick={save}
        >
          {busy ? "Saving…" : "Save package type"}
        </button>
      </div>
      {prods.length > 0 && (
        <label className="check small" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={assign}
            onChange={(e) => setAssign(e.target.checked)}
          />{" "}
          Use it for {oneProduct ? "this product" : "these products"} (
          {prods.map((l) => l.sku || l.title).join(", ")}) from now on
          {oneProduct && prods[0].quantity > 1
            ? ` — note: this size is for ${prods[0].quantity} units`
            : ""}
          {!oneProduct ? " — note: this is the size of the whole order" : ""}
        </label>
      )}
    </div>
  );
}

// Live serviceability + expected charges for one order (read-only, in the order view).
function CourierRates({ id }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [packages, setPackages] = useState([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    api
      .get("/shopify/package-types")
      .then((r) => setPackages(r.data))
      .catch(() => {});
  }, []);
  useEffect(() => {
    api
      .post("/shopify/orders/quotes", { ids: [id] })
      .then((r) => setD(r.data.orders[0]))
      .catch((e) => setErr(errMsg(e)));
  }, [id, n]);
  if (err) return <p className="muted small">Courier charges: {err}</p>;
  if (!d)
    return <p className="muted small">Checking couriers for this pincode…</p>;
  const linePkgs = (
    <LinePackages
      lines={d.lines}
      packages={packages}
      onChanged={() => setN((x) => x + 1)}
    />
  );
  if (d.error || d.needsPackage)
    return (
      <>
        <p className="muted small">
          {d.error ||
            "Set a package type on the product below (or enter the weight and size when booking) to see courier charges."}
        </p>
        {linePkgs}
      </>
    );
  const rows = choicesOf(d.rows);
  if (!rows.length)
    return (
      <p className="muted small">
        No active couriers. Add one in Store Settings → Couriers.
      </p>
    );
  return (
    <>
      {linePkgs}
      <div className="muted small" style={{ margin: "4px 0" }}>
        To {d.pincode} {d.city} ·{" "}
        {d.cod ? `COD ${money(d.codAmount)}` : "Prepaid"} · Package:{" "}
        {pkgText(d.pkg)}
      </div>
      <table className="table compact">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={r.serviceable === false ? "muted" : ""}>
              <td>
                {r.name}
                {r.sub && <span className="muted"> · {r.sub}</span>}
                {i === 0 && r.serviceable !== false && r.charge != null && (
                  <span className="pill pill-green" style={{ marginLeft: 6 }}>
                    Cheapest
                  </span>
                )}
              </td>
              <td>
                <ServBadge v={r.serviceable} note={r.note} />
                {r.note && r.serviceable !== true && (
                  <div className="muted small">{r.note}</div>
                )}
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

// Book in several boxes: everything in one box, each unit in its own box, or your own split (n boxes, each
// unit put in a box), with each box's weight and size (blank = from its products' package types).
function BoxesEditor({ orderId, onChange }) {
  const [lines, setLines] = useState(null);
  const [mode, setMode] = useState("one"); // one | each | custom
  const [n, setN] = useState(2);
  const [nText, setNText] = useState("2");
  const [assign, setAssign] = useState({}); // "lineId#unit" (or "lineId#unit~part") → box number
  const [pieces, setPieces] = useState({}); // "lineId#unit" → packed in this many boxes (one big item in 2 cartons)
  const [pkgs, setPkgs] = useState({}); // box → { weight, length, breadth, height }
  const [done, setDone] = useState({ alreadyFulfilled: [], fulfillments: [] });
  useEffect(() => {
    // Only what's still to ship: units already fulfilled in Shopify (e.g. a seller's own shipment) are left out.
    api
      .get(`/shopify/orders/${orderId}/shippable`)
      .then((r) => {
        setLines(
          (r.data.lines || [])
            .map((l) => ({ ...l, quantity: l.toShip }))
            .filter((l) => l.quantity > 0),
        );
        setDone(r.data);
      })
      .catch(() => setLines([]));
  }, [orderId]);
  const baseUnits = (lines || []).flatMap((l) =>
    Array.from({ length: l.quantity }, (_, u) => ({
      key: `${l.lineId}#${u}`,
      lineId: l.lineId,
      title: l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title,
      sku: l.sku,
      u,
    })),
  );
  const totalUnits = baseUnits.length;
  // Each unit, or each part of a unit packed in several boxes, goes in one box.
  const units =
    mode === "one"
      ? baseUnits
      : baseUnits.flatMap((x) => {
          const of = Number(pieces[x.key]) || 1;
          return Array.from({ length: of }, (_, p) => ({
            ...x,
            unitKey: x.key,
            key: p ? `${x.key}~${p + 1}` : x.key,
            part: p + 1,
            of,
          }));
        });
  const totalParts = units.length;
  const boxOf = (x, i) =>
    mode === "each"
      ? i + 1
      : mode === "custom"
        ? Number(assign[x.key]) || (x.part > 1 ? Math.min(n, x.part) : 1)
        : 1;
  const count = mode === "each" ? totalParts : mode === "custom" ? n : 1;
  useEffect(() => {
    if (mode === "one" || totalParts < 2) return onChange(null);
    const out = Array.from({ length: count }, (_, b) => {
      const m = new Map();
      const parts = [];
      units.forEach((x, i) => {
        if (boxOf(x, i) !== b + 1) return;
        if (x.of > 1)
          parts.push({ lineId: x.lineId, quantity: 1, part: x.part, of: x.of });
        else m.set(x.lineId, (m.get(x.lineId) || 0) + 1);
      });
      const pk = pkgs[b + 1] || {};
      const ok = ["weight", "length", "breadth", "height"].every(
        (k) => Number(pk[k]) > 0,
      );
      return {
        lines: [
          ...[...m].map(([lineId, quantity]) => ({ lineId, quantity })),
          ...parts,
        ],
        pkg: ok
          ? Object.fromEntries(
              Object.entries(pk).map(([k, v]) => [k, Number(v)]),
            )
          : {},
      };
    }).filter((b) => b.lines.length);
    onChange(out.length > 1 ? out : null);
  }, [
    mode,
    n,
    JSON.stringify(assign),
    JSON.stringify(pieces),
    JSON.stringify(pkgs),
    lines,
  ]);
  const doneNote = (done.alreadyFulfilled || []).length > 0 && (
    <div className="alert alert-info small" style={{ marginBottom: 8 }}>
      Already fulfilled in Shopify — not booked again:{" "}
      {done.alreadyFulfilled
        .map((d) => `${d.quantity} × ${d.title}`)
        .join(", ")}
      {(done.fulfillments || []).length > 0 &&
        ` (${done.fulfillments
          .map((f) => `${f.courier} ${f.awb}`.trim())
          .filter(Boolean)
          .join(", ")})`}
      .{" "}
      {lines?.length
        ? "This booking covers only the remaining products."
        : "Nothing is left to ship on this order."}
    </div>
  );
  if (!lines || !totalUnits) return doneNote || null;
  const setPk = (b, k) => (e) =>
    setPkgs({ ...pkgs, [b]: { ...(pkgs[b] || {}), [k]: e.target.value } });
  const used = new Set(units.map((x, i) => boxOf(x, i)));
  return (
    <div className="card" style={{ background: "var(--bg-2, #f7f8fa)" }}>
      {doneNote}
      <div className="label-sm">Boxes</div>
      <div className="seg" role="group" style={{ margin: "4px 0 8px" }}>
        {[
          ["one", "All in one box"],
          ...(totalParts > 1
            ? [["each", `Each item in its own box (${totalParts})`]]
            : []),
          ["custom", "Split into boxes…"],
        ].map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={mode === k ? "on" : ""}
            onClick={() => setMode(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {mode === "custom" && (
        <>
          <Field label="Number of boxes">
            <input
              type="number"
              min="2"
              max={Math.min(20, Math.max(2, totalParts))}
              value={nText}
              onChange={(e) => {
                // Type freely (e.g. "14"); the count is used once it's a valid number, and tidied on leaving the box.
                setNText(e.target.value);
                const v = Number(e.target.value);
                if (v >= 2 && v <= 20) setN(v);
              }}
              onBlur={() => {
                const v = Math.max(2, Math.min(20, Number(nText) || n));
                setN(v);
                setNText(String(v));
              }}
              style={{ maxWidth: 90 }}
            />
          </Field>
          <table className="table" style={{ marginTop: 6 }}>
            <tbody>
              {units.map((x) => (
                <tr key={x.key}>
                  <td className="small">
                    {x.title}
                    {x.sku && <span className="muted"> · {x.sku}</span>}
                    {(lines.find((l) => l.lineId === x.lineId)?.quantity || 1) >
                      1 && <span className="muted"> · unit {x.u + 1}</span>}
                    {x.of > 1 && (
                      <strong>
                        {" "}
                        · part {x.part} of {x.of}
                      </strong>
                    )}
                    {x.part === 1 && (
                      <div>
                        <select
                          className="small"
                          value={x.of}
                          title="One item packed in several cartons: each carton is its own box with its own AWB"
                          onChange={(e) =>
                            setPieces({
                              ...pieces,
                              [x.unitKey]: Number(e.target.value),
                            })
                          }
                          style={{ marginTop: 2, width: "auto" }}
                        >
                          {[1, 2, 3, 4, 5].map((k) => (
                            <option key={k} value={k}>
                              {k === 1
                                ? "Packed in 1 box"
                                : `Packed in ${k} boxes`}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </td>
                  <td style={{ width: 120 }}>
                    <select
                      value={assign[x.key] || 1}
                      onChange={(e) =>
                        setAssign({
                          ...assign,
                          [x.key]: Number(e.target.value),
                        })
                      }
                    >
                      {Array.from({ length: n }, (_, b) => (
                        <option key={b} value={b + 1}>
                          Box {b + 1}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {used.size < n && (
            <div className="small text-amber">
              Some boxes are empty — they're left out.
            </div>
          )}
        </>
      )}
      {mode !== "one" && (
        <>
          <div className="small muted" style={{ margin: "8px 0 4px" }}>
            Each box is booked with its own AWB and label, and marked fulfilled
            in Shopify with its own tracking (an item packed in several boxes is
            marked fulfilled with its part 1). COD is shared by value. Weight
            and size per box (blank = from the products' package types — enter
            them for the parts of a split item):
          </div>
          {[...used]
            .sort((a, b) => a - b)
            .map((b) => (
              <div
                key={b}
                className="row-4"
                style={{ alignItems: "end", marginBottom: 4 }}
              >
                <div className="small">
                  <strong>Box {b}</strong>
                  <div className="muted">
                    {units
                      .filter((x, i) => boxOf(x, i) === b)
                      .map((x) =>
                        x.of > 1
                          ? `${x.title} (part ${x.part}/${x.of})`
                          : x.title,
                      )
                      .join(", ")
                      .slice(0, 80)}
                  </div>
                </div>
                <input
                  type="number"
                  step="0.1"
                  placeholder="kg"
                  value={pkgs[b]?.weight || ""}
                  onChange={setPk(b, "weight")}
                />
                <input
                  type="number"
                  placeholder="L×B×H cm: L"
                  value={pkgs[b]?.length || ""}
                  onChange={setPk(b, "length")}
                />
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    type="number"
                    placeholder="B"
                    value={pkgs[b]?.breadth || ""}
                    onChange={setPk(b, "breadth")}
                  />
                  <input
                    type="number"
                    placeholder="H"
                    value={pkgs[b]?.height || ""}
                    onChange={setPk(b, "height")}
                  />
                </div>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function ShipModal({ ids, couriers, onClose, onDone }) {
  const active = couriers.filter((c) => c.active);
  const single = ids.length === 1;
  const [packages, setPackages] = useState([]);
  const [mode, setMode] = useState("auto"); // auto | <package type id> | manual
  const [manualPkg, setManualPkg] = useState({
    weight: "",
    length: "",
    breadth: "",
    height: "",
  });
  const [quotes, setQuotes] = useState(null);
  const [checking, setChecking] = useState(false);
  const [pick, setPick] = useState(null); // { account, courierId, key }
  const [manual, setManual] = useState({ awb: "", courierName: "" });
  const [invoiceFirst, setInvoiceFirst] = useState(false);
  const [skipCheck, setSkipCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState(false);
  const [pickupFrom, setPickupFrom] = useState(""); // "" automatic | "own" | "seller:<id>"
  const [sellerList, setSellerList] = useState([]);
  // Several boxes (one order): null = one box with everything, else [{ lines: [{ lineId, quantity }], pkg }].
  const [boxes, setBoxes] = useState(null);
  const [boxAwbs, setBoxAwbs] = useState([]);
  const manualOk = ["weight", "length", "breadth", "height"].every(
    (k) => Number(manualPkg[k]) > 0,
  );
  const pkgBody =
    mode === "auto"
      ? {}
      : mode === "manual"
        ? manualOk
          ? Object.fromEntries(
              Object.entries(manualPkg).map(([k, v]) => [k, Number(v)]),
            )
          : null
        : { packageType: mode };
  // Split into boxes: the order-level size isn't needed; courier rates are checked with the heaviest box's size.
  const boxPkg = (boxes || [])
    .map((b) => b.pkg)
    .filter((p) => Number(p?.weight) > 0)
    .sort((a, b) => b.weight - a.weight)[0];
  const quotePkg = pkgBody || (boxes ? boxPkg || {} : null);
  const pkgKey = JSON.stringify(quotePkg) + refresh + pickupFrom;
  const loadPackages = () =>
    api
      .get("/shopify/package-types")
      .then((r) => setPackages(r.data))
      .catch(() => {});

  useEffect(() => {
    loadPackages();
    api
      .get("/sellers")
      .then((r) => setSellerList(r.data.filter((x) => x.active !== false)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!quotePkg || !active.length) return;
    let live = true;
    setChecking(true);
    const t = setTimeout(
      () =>
        api
          .post("/shopify/orders/quotes", {
            ids: ids.slice(0, 50),
            pkg: quotePkg,
            pickupFrom,
          })
          .then((r) => {
            if (!live) return;
            setQuotes(r.data);
            const o = r.data.orders[0];
            if (single && mode === "auto" && o?.needsPackage) setMode("manual");
            if (single && mode === "auto" && o?.pkg)
              setManualPkg({
                weight: o.pkg.weight,
                length: o.pkg.length,
                breadth: o.pkg.breadth,
                height: o.pkg.height,
              });
            // Pre-select the cheapest courier that delivers there.
            const list = single
              ? choicesOf(o?.rows || [])
              : (r.data.summary || []).map((s) => ({
                  ...s,
                  key: s.account,
                  serviceable: s.serviceable + s.unknown > 0 ? true : false,
                }));
            setPick((cur) => {
              if (
                cur &&
                list.some((x) => x.key === cur.key && x.serviceable !== false)
              )
                return cur;
              const best = list.find((x) => x.serviceable !== false) || list[0];
              return best
                ? {
                    account: best.account,
                    courierId: best.courierId || "",
                    key: best.key,
                  }
                : null;
            });
          })
          .catch((e) => live && toast(errMsg(e), "error"))
          .finally(() => live && setChecking(false)),
      mode === "manual" ? 600 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pkgKey]);

  const acc = active.find((c) => c._id === pick?.account);
  const order = single ? quotes?.orders?.[0] : null;
  const choices = single ? choicesOf(order?.rows || []) : [];
  const chosen = single
    ? choices.find((c) => c.key === pick?.key)
    : quotes?.summary?.find((s) => s.account === pick?.account);
  const blocked = single && chosen?.serviceable === false && !skipCheck;
  const needPkg = mode === "manual" && !manualOk && !(single && boxes);
  const needAwbs =
    acc?.carrier === "custom" &&
    single &&
    (boxes ? boxes.some((_, i) => !boxAwbs[i]) : !manual.awb);
  const whyNot = busy
    ? ""
    : checking && !pick
      ? "Checking couriers…"
      : !pick
        ? boxes
          ? "Enter the weight and size of the boxes to check couriers"
          : "Choose a courier"
        : needPkg
          ? "Enter the package weight and size"
          : blocked
            ? "This courier doesn't deliver there — choose another or tick the override"
            : needAwbs
              ? boxes
                ? "Enter the AWB of every box"
                : "Enter the AWB"
              : "";
  const autoMissing =
    !single && quotes?.orders?.filter((o) => o.needsPackage).length;

  const go = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/orders/ship", {
        ids,
        account: pick.account,
        pkg: pkgBody || {},
        manual: { ...manual, courierId: pick.courierId || "" },
        invoiceFirst,
        skipCheck,
        pickupFrom,
        ...(single && boxes
          ? {
              boxes,
              manual: {
                ...manual,
                courierId: pick.courierId || "",
                awbs: boxAwbs,
              },
            }
          : {}),
      });
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
          {whyNot && (
            <span className="small text-amber" style={{ marginRight: "auto" }}>
              {whyNot}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !pick || needPkg || blocked || needAwbs}
            onClick={go}
          >
            {busy
              ? "Checking pincode & booking…"
              : chosen?.charge != null
                ? `Book · ${money(chosen.charge)}`
                : "Book Shipment"}
          </button>
        </>
      }
    >
      {!active.length ? (
        <p>
          No courier set up yet.{" "}
          <Link to="/shopify-settings#couriers">Add a courier</Link>{" "}
          (Shiprocket, Delhivery, Blue Dart, DTDC, Shadowfax or your own).
        </p>
      ) : (
        <div className="form-grid">
          <PaymentBanner orders={quotes?.orders} />
          <Field
            label="Package"
            hint={
              mode === "auto"
                ? single
                  ? order?.pkg
                    ? `From the products: ${pkgText(order.pkg)}`
                    : order?.needsPackage
                      ? "Its products have no package type — choose one or enter the size"
                      : ""
                  : "Each order uses its own products' package types"
                : ""
            }
          >
            <SearchSelect
              value={mode}
              options={[
                { value: "auto", label: "From the products' package types" },
                { value: "manual", label: "Enter weight and size" },
                ...packageOptions(packages),
              ]}
              onChange={(v) => v && setMode(v)}
              placeholder="Search package types…"
            />
          </Field>
          {single &&
            (order?.lines || quotes?.orders?.[0]?.lines)?.length > 0 &&
            (mode === "auto" || mode === "manual") && (
              <>
                <div className="label-sm" style={{ marginBottom: -6 }}>
                  Product package type{" "}
                  <span className="muted">
                    (used automatically for this product's orders)
                  </span>
                </div>
                <LinePackages
                  lines={order?.lines || quotes?.orders?.[0]?.lines}
                  packages={packages}
                  onChanged={() => {
                    loadPackages();
                    setMode("auto");
                    setRefresh((x) => x + 1);
                  }}
                />
              </>
            )}
          {mode === "manual" && (
            <div className="row-4">
              {[
                ["weight", "Weight (kg)"],
                ["length", "Length (cm)"],
                ["breadth", "Breadth (cm)"],
                ["height", "Height (cm)"],
              ].map(([k, l]) => (
                <Field key={k} label={l} required>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={manualPkg[k]}
                    onChange={(e) => (
                      setManualPkg({ ...manualPkg, [k]: e.target.value }),
                      setSaved(false)
                    )}
                  />
                </Field>
              ))}
            </div>
          )}
          {single && mode === "manual" && manualOk && !saved && (
            <SaveAsPackage
              dims={manualPkg}
              lines={order?.lines || quotes?.orders?.[0]?.lines}
              onSaved={(pt) => {
                setSaved(true);
                // Given to the product: book "from the products" (and its next orders will too); else use it here.
                loadPackages().then(() => {
                  setMode(pt.assigned ? "auto" : pt._id);
                  setRefresh((x) => x + 1);
                });
              }}
            />
          )}
          {autoMissing > 0 && mode === "auto" && (
            <p className="alert alert-warn">
              {autoMissing} of these orders have products without a package type
              — they won't be booked. Choose a package above to use it for all.
            </p>
          )}

          {single &&
            order &&
            (order.pickupNote || order.pickup?.seller || pickupFrom) && (
              <Field
                label="Pickup from"
                hint={
                  order.pickupNote && !pickupFrom
                    ? order.pickupNote
                    : order.pickup?.seller
                      ? `Marketplace seller's address: ${[order.pickup.city, order.pickup.pincode].filter(Boolean).join(" ")}`
                      : ""
                }
              >
                <select
                  value={pickupFrom}
                  onChange={(e) => setPickupFrom(e.target.value)}
                >
                  <option value="">
                    {order.pickup?.seller
                      ? `${order.pickup.name} (seller)`
                      : order.pickupNote
                        ? "Choose…"
                        : "Our address"}
                  </option>
                  <option value="own">Our address</option>
                  {sellerList.map((x) => (
                    <option key={x._id} value={`seller:${x._id}`}>
                      {x.name} —{" "}
                      {[x.pickup?.city, x.pickup?.pincode]
                        .filter(Boolean)
                        .join(" ")}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          {!single && sellerList.length > 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              Marketplace sellers' orders are picked up from each seller's
              address. Orders with products from several sellers must be booked
              one at a time.
            </p>
          )}
          <div className="label-sm">
            Couriers{" "}
            {single && order
              ? `to ${order.pincode} ${order.city} · ${order.cod ? `COD ${money(order.codAmount)}` : "Prepaid"}`
              : ""}{" "}
            {checking && <span className="muted">· checking live…</span>}
          </div>
          {needPkg ? (
            <p className="muted small">
              Enter the weight and size to check couriers and rates.
            </p>
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
                  <tr
                    key={r.key}
                    className={r.serviceable === false ? "muted" : ""}
                    onClick={() =>
                      setPick({
                        account: r.account,
                        courierId: r.courierId,
                        key: r.key,
                      })
                    }
                  >
                    <td>
                      <input
                        type="radio"
                        readOnly
                        checked={pick?.key === r.key}
                      />
                    </td>
                    <td>
                      {r.name}
                      {r.sub && <span className="muted"> · {r.sub}</span>}
                      {r.test && <span className="muted"> (test)</span>}
                      {i === 0 &&
                        r.serviceable !== false &&
                        r.charge != null && (
                          <span
                            className="pill pill-green"
                            style={{ marginLeft: 6 }}
                          >
                            Cheapest
                          </span>
                        )}
                    </td>
                    <td>
                      <ServBadge v={r.serviceable} note={r.note} />
                      {r.note && r.serviceable !== true && (
                        <div className="muted small">{r.note}</div>
                      )}
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
                  <tr
                    key={s.account}
                    onClick={() =>
                      setPick({
                        account: s.account,
                        courierId: "",
                        key: s.account,
                      })
                    }
                  >
                    <td>
                      <input
                        type="radio"
                        readOnly
                        checked={pick?.account === s.account}
                      />
                    </td>
                    <td>{s.name}</td>
                    <td>
                      {s.serviceable} of {quotes.orders.length}
                      {s.unknown ? (
                        <span className="muted">
                          {" "}
                          · {s.unknown} not checked
                        </span>
                      ) : (
                        ""
                      )}
                      {s.notServiceable.length > 0 && (
                        <div className="text-red small">
                          Can't deliver:{" "}
                          {s.notServiceable.slice(0, 8).join(", ")}
                          {s.notServiceable.length > 8 ? "…" : ""}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {s.priced ? (
                        <>
                          {money(s.total)}{" "}
                          <span className="muted small">
                            ({s.priced} priced)
                          </span>
                        </>
                      ) : (
                        <span className="muted small">No rate</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!single && ids.length > 50 && (
            <p className="muted small">
              Rates are shown for the first 50 orders; every order's pincode is
              still checked when it's booked.
            </p>
          )}
          {!single && (
            <p className="muted small">
              Each order's pincode is checked live when it's booked; orders the
              courier can't deliver to are skipped and listed.
            </p>
          )}
          {single && chosen?.serviceable === false && (
            <label className="check">
              <input
                type="checkbox"
                checked={skipCheck}
                onChange={(e) => setSkipCheck(e.target.checked)}
              />{" "}
              Book anyway (the courier says it doesn't deliver here)
            </label>
          )}

          {acc?.carrier === "custom" &&
            (single ? (
              <div className="row-2">
                <Field label="AWB / Tracking number" required>
                  <input
                    value={manual.awb}
                    onChange={(e) =>
                      setManual({ ...manual, awb: e.target.value })
                    }
                  />
                </Field>
                <Field label="Courier name" hint={`Defaults to ${acc.name}`}>
                  <input
                    value={manual.courierName}
                    onChange={(e) =>
                      setManual({ ...manual, courierName: e.target.value })
                    }
                  />
                </Field>
              </div>
            ) : (
              <p className="alert alert-warn">
                Custom couriers need an AWB for each order — book them one at a
                time.
              </p>
            ))}
          {single && <BoxesEditor orderId={ids[0]} onChange={setBoxes} />}
          {single && boxes && acc?.carrier === "custom" && (
            <div className="row-4">
              {boxes.map((_, i) => (
                <Field key={i} label={`Box ${i + 1} AWB`}>
                  <input
                    value={boxAwbs[i] || ""}
                    onChange={(e) =>
                      setBoxAwbs(
                        Object.assign([...boxAwbs], { [i]: e.target.value }),
                      )
                    }
                  />
                </Field>
              ))}
            </div>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={invoiceFirst}
              onChange={(e) => setInvoiceFirst(e.target.checked)}
            />{" "}
            Also create the invoice (optional — its number then goes on the
            shipment)
          </label>
        </div>
      )}
    </Modal>
  );
}

const AmazonBadge = ({ o }) =>
  o.channel === "amazon" ? (
    <span className="status status-sent" title="Amazon order">
      {o.amazon?.easyShip ? "Amazon · Easy Ship" : "Amazon"}
    </span>
  ) : o.channel === "flipkart" ? (
    <span className="status status-sent" title="Flipkart order">
      {o.flipkart?.selfShip ? "Flipkart · Self-ship" : "Flipkart"}
    </span>
  ) : null;
const slotText = (s) =>
  s?.start
    ? `${new Date(s.start).toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}${s.end ? ` – ${new Date(s.end).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : ""}`
    : "";

// Amazon Easy Ship: Amazon picks the parcel up. Package → pickup slots → schedule → Amazon's label.
// Flipkart logistics: box size and weight → Flipkart packs the shipment and makes its label + invoice.
function FlipkartPackModal({ order, onClose, onDone }) {
  const prev = order.flipkart?.pkg || {};
  const [p, setP] = useState({
    length: prev.length || "",
    breadth: prev.breadth || "",
    height: prev.height || "",
    weight: prev.weight || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/flipkart-orders/orders/${order._id}/pack`, {
        length: Number(p.length),
        breadth: Number(p.breadth),
        height: Number(p.height),
        weight: Number(p.weight),
      });
      toast("Packed on Flipkart — the label is ready in a few seconds");
      onDone();
      setTimeout(() => openPdf(`/shopify/orders/${order._id}/label`), 6000);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title={`Pack ${order.name} on Flipkart`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !p.length || !p.breadth || !p.height || !p.weight}
            onClick={go}
          >
            {busy ? "Packing…" : "Pack & get label"}
          </button>
        </>
      }
    >
      <p className="small muted">
        Box size and weight as packed. The GST rate of each item is taken from
        OrdexaGo; Flipkart makes the invoice.
      </p>
      <div className="grid-4">
        <Field label="Length (cm)">
          <input
            type="number"
            min="1"
            value={p.length}
            onChange={set("length")}
          />
        </Field>
        <Field label="Breadth (cm)">
          <input
            type="number"
            min="1"
            value={p.breadth}
            onChange={set("breadth")}
          />
        </Field>
        <Field label="Height (cm)">
          <input
            type="number"
            min="1"
            value={p.height}
            onChange={set("height")}
          />
        </Field>
        <Field label="Weight (kg)">
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={p.weight}
            onChange={set("weight")}
          />
        </Field>
      </div>
    </Modal>
  );
}

function EasyShipModal({ order, onClose, onDone }) {
  const [packages, setPackages] = useState([]);
  const [mode, setMode] = useState("auto");
  const [manualPkg, setManualPkg] = useState({
    weight: "",
    length: "",
    breadth: "",
    height: "",
  });
  const [slots, setSlots] = useState(null);
  const [pkg, setPkg] = useState(null);
  const [slotId, setSlotId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get("/shopify/package-types")
      .then((r) => setPackages(r.data))
      .catch(() => {});
  }, []);
  const pkgBody =
    mode === "auto"
      ? {}
      : mode === "manual"
        ? manualPkg
        : { packageType: mode };
  const getSlots = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/amazon-orders/orders/${order._id}/easyship/slots`,
        { pkg: pkgBody },
      );
      setSlots(data.slots);
      setPkg(data.pkg);
      setSlotId(data.slots[0]?.slotId || "");
      if (!data.slots.length)
        toast("Amazon has no pickup slots for this order right now", "error");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const schedule = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/amazon-orders/orders/${order._id}/easyship/schedule`,
        { slotId, pkg: pkgBody },
      );
      toast(
        `Pickup scheduled${data.slot ? ` for ${slotText(data.slot)}` : ""}`,
      );
      if (data.warning) toast(data.warning, "error");
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title={`Easy Ship pickup — ${order.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {slots ? (
            <button
              className="btn btn-primary"
              disabled={busy || !slotId}
              onClick={schedule}
            >
              Schedule pickup
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={getSlots}
            >
              Get pickup slots
            </button>
          )}
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        Amazon's courier collects the parcel from your pickup address in the
        slot you choose. Amazon makes the shipping label; print it from the
        order once scheduled.
      </p>
      <Field label="Package">
        <select
          value={mode}
          onChange={(e) => (setMode(e.target.value), setSlots(null))}
        >
          <option value="auto">From the products' package types</option>
          {packages.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name} — {p.weight} kg · {p.length}×{p.breadth}×{p.height} cm
            </option>
          ))}
          <option value="manual">Enter weight and size</option>
        </select>
      </Field>
      {mode === "manual" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 10,
          }}
        >
          {[
            ["weight", "Weight (kg)"],
            ["length", "Length (cm)"],
            ["breadth", "Breadth (cm)"],
            ["height", "Height (cm)"],
          ].map(([k, l]) => (
            <Field key={k} label={l}>
              <input
                type="number"
                min="0"
                step="0.01"
                value={manualPkg[k]}
                onChange={(e) => (
                  setManualPkg({ ...manualPkg, [k]: e.target.value }),
                  setSlots(null)
                )}
              />
            </Field>
          ))}
        </div>
      )}
      {pkg && slots && (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {pkg.packageName ? `${pkg.packageName} · ` : ""}
            {pkg.weight} kg · {pkg.length}×{pkg.breadth}×{pkg.height} cm
          </div>
          <div className="label-sm">Pickup slot</div>
          {slots.map((x) => (
            <label
              key={x.slotId}
              className="check-row"
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "6px 0",
              }}
            >
              <input
                type="radio"
                name="slot"
                checked={slotId === x.slotId}
                onChange={() => setSlotId(x.slotId)}
              />
              {slotText(x)}{" "}
              <span className="muted small">
                {x.method === "DROPOFF" ? "drop off" : "pickup"}
              </span>
            </label>
          ))}
        </>
      )}
    </Modal>
  );
}

// B2B invoice: the buyer's GSTIN and registered name. Already invoiced → the invoice moves to that customer.
function B2bBox({ o, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [gstin, setGstin] = useState(o.b2b?.gstin || "");
  const [name, setName] = useState(
    o.b2b?.name ||
      o.billingAddress?.company ||
      o.shippingAddress?.company ||
      "",
  );
  const [busy, setBusy] = useState(false);
  const save = async (clear) => {
    const g = clear ? "" : gstin.trim().toUpperCase();
    if (
      o.invoice &&
      !window.confirm(
        g
          ? `Invoice ${o.invoiceNumber} will be moved to ${name || g} (GSTIN ${g}). In GSTR-1 it moves from B2C to B2B. Continue?`
          : `Invoice ${o.invoiceNumber} will go back to the B2C (consumer) customer. Continue?`,
      )
    )
      return;
    setBusy(true);
    try {
      const { data } = await api.put(`/shopify/orders/${o._id}/b2b`, {
        gstin: g,
        name: clear ? "" : name.trim(),
      });
      toast(
        data.movedTo
          ? `Invoice ${data.invoiceNumber} moved to ${data.movedTo}`
          : g
            ? "GSTIN saved — the invoice will be B2B"
            : "Back to B2C",
      );
      setEdit(false);
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  if (!edit)
    return (
      <div className="small" style={{ marginTop: 6 }}>
        {o.b2b?.gstin ? (
          <>
            <span className="badge">B2B</span> {o.b2b.name} · GSTIN{" "}
            {o.b2b.gstin}{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => setEdit(true)}
            >
              Change
            </button>
          </>
        ) : (
          <button
            type="button"
            className="link-btn"
            onClick={() => setEdit(true)}
          >
            + Add customer GSTIN (B2B invoice)
          </button>
        )}
      </div>
    );
  return (
    <div className="card pad" style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <input
        placeholder="Customer GSTIN, e.g. 09ABCDE1234F1Z5"
        value={gstin}
        maxLength={15}
        onChange={(e) => setGstin(e.target.value.toUpperCase())}
        autoFocus
      />
      <input
        placeholder="Registered business name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || gstin.trim().length !== 15 || !name.trim()}
          onClick={() => save(false)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {o.b2b?.gstin && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => save(true)}
          >
            Remove GSTIN (B2C)
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setEdit(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// COD order with an advance paid by UPI / bank: note it, so the courier collects only the rest.
function AdvanceBox({ o, onSaved }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const total = o.total || 0;
  const save = async (value) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/shopify/orders/${o._id}/advance`, {
        amount: Number(value) || 0,
        reference,
      });
      toast(
        Number(value)
          ? `Advance noted · collect ${money(data.collect)} on delivery`
          : "Advance removed",
      );
      setOpen(false);
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="label-sm">Advance</div>
      {o.paymentMode === "partial" && (
        <div className="small">
          {money(o.prepaidAmount)} received · collect {money(o.codAmount)} on
          delivery{" "}
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={() =>
              window.confirm(
                "Remove the advance? The whole amount becomes COD.",
              ) && save(0)
            }
          >
            remove
          </button>
        </div>
      )}
      {!open ? (
        <button
          type="button"
          className="link-btn small"
          onClick={() => setOpen(true)}
        >
          {o.paymentMode === "partial"
            ? "Change advance"
            : "+ Advance received (UPI / bank) — COD only for the rest"}
        </button>
      ) : (
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}
        >
          <input
            type="number"
            min="1"
            step="0.01"
            placeholder="Advance ₹"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ maxWidth: 130 }}
            autoFocus
          />
          <input
            placeholder="UTR / reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            style={{ maxWidth: 170 }}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !(Number(amount) > 0) || Number(amount) >= total}
            onClick={() => save(amount)}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          {Number(amount) > 0 && (
            <span className="small muted">
              COD to collect: {money(Math.max(0, total - Number(amount)))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Reverse pickup booked on an order: courier, AWB, tracking; refresh or cancel.
function ReverseBox({ o, readOnly, onChanged }) {
  const rv = o.reverse;
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
    onChanged();
  };
  const cancel = () =>
    window.confirm(`Cancel reverse pickup ${rv.awb}?`) &&
    run(async () => {
      try {
        await api.post(`/shopify/orders/${o._id}/reverse/cancel`);
      } catch (e) {
        if (!e.response?.data?.courierRefused) throw e;
        if (
          !window.confirm(
            `${e.response.data.message}\n\nCancel it in OrdexaGo anyway? Cancel it on the courier's portal yourself.`,
          )
        )
          return;
        await api.post(`/shopify/orders/${o._id}/reverse/cancel`, {
          force: true,
        });
      }
      toast("Reverse pickup cancelled");
    });
  const st = rv.deliveredAt
    ? "Back with " + (rv.returnToName || "you")
    : rv.trackText ||
      (rv.trackStatus
        ? TRACK_LABEL[rv.trackStatus] || rv.trackStatus
        : "Waiting for pickup");
  return (
    <div
      className={`alert ${rv.deliveredAt ? "alert-success" : "alert-info"}`}
      style={{ marginTop: 10 }}
    >
      <strong>Reverse pickup</strong> · {rv.courierName}{" "}
      {rv.trackingUrl ? (
        <a href={rv.trackingUrl} target="_blank" rel="noreferrer">
          {rv.awb}
        </a>
      ) : (
        rv.awb
      )}{" "}
      · {st}
      <div className="small">
        {rv.reason}
        {rv.note ? ` — ${rv.note}` : ""} · back to {rv.returnToName || "you"} ·
        booked{" "}
        {new Date(rv.bookedAt).toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {rv.by ? ` by ${rv.by}` : ""}
        {rv.refs?.token ? ` · pickup token ${rv.refs.token}` : ""}
        {rv.refs?.pickupError ? (
          <span className="text-red">
            {" "}
            · pickup not registered: {rv.refs.pickupError}
          </span>
        ) : (
          ""
        )}
      </div>
      {rv.deliveredAt && (
        <div className="small">
          Check the product, then close the return (Scan Returns, or Mark Return
          Closed): stock and credit note as usual.
        </div>
      )}
      {!readOnly && !rv.deliveredAt && (
        <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              run(() => api.post(`/shopify/orders/${o._id}/reverse/track`))
            }
          >
            Refresh tracking
          </button>
          {!["in_transit", "out_for_delivery"].includes(rv.trackStatus) && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={cancel}
            >
              Cancel reverse pickup
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Book a reverse pickup: reason, courier, where it goes back to, package.
function ReverseModal({ order, couriers, onClose, onDone }) {
  const active = couriers.filter((c) => c.active);
  const [reasons, setReasons] = useState([]);
  const [f, setF] = useState({
    reason: "",
    note: "",
    accountId: active[0]?._id || "",
    returnTo: "",
    awb: "",
    weight: "",
    length: "",
    breadth: "",
    height: "",
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get("/shopify/reverse-reasons")
      .then((r) => setReasons(r.data))
      .catch(() => {});
  }, []);
  const acc = active.find((c) => c._id === f.accountId);
  const manualOnly = acc && ["custom", "shadowfax"].includes(acc.carrier);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const a = order.shippingAddress || {};
  const submit = async () => {
    if (!f.reason) return toast("Choose the reason", "error");
    if (manualOnly && !f.awb.trim())
      return toast(
        `Book it on ${acc.name}'s portal and enter the AWB`,
        "error",
      );
    setBusy(true);
    try {
      const pkg =
        Number(f.weight) > 0
          ? {
              weight: f.weight,
              length: f.length,
              breadth: f.breadth,
              height: f.height,
            }
          : {};
      const { data } = await api.post(`/shopify/orders/${order._id}/reverse`, {
        accountId: f.accountId,
        reason: f.reason,
        note: f.note,
        returnTo: f.returnTo,
        pkg,
        manual: f.awb.trim() ? { awb: f.awb.trim() } : {},
      });
      toast(
        `Reverse pickup booked: ${data.reverse?.courierName || ""} ${data.reverse?.awb || ""}`.trim(),
      );
      if (data.warning) toast(data.warning, "error");
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title={`Reverse pickup — ${order.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.accountId}
            onClick={submit}
          >
            {busy ? "Booking…" : "Book reverse pickup"}
          </button>
        </>
      }
    >
      <p className="small" style={{ marginTop: 0 }}>
        Picked up from <strong>{a.name || order.customer?.name}</strong>,{" "}
        {[a.address1, a.city, a.zip].filter(Boolean).join(", ")} ·{" "}
        {a.phone || order.customer?.phone}. The return is also created in
        Shopify. When it's back, close the return as usual.
      </p>
      <div className="form-grid">
        <div className="row-2">
          <Field label="Reason" required>
            <select value={f.reason} onChange={set("reason")}>
              <option value="">Choose…</option>
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Courier" required>
            <select value={f.accountId} onChange={set("accountId")}>
              {active.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note (what the customer said, photos received…)">
          <input value={f.note} onChange={set("note")} />
        </Field>
        <Field
          label="Goes back to"
          hint="Seller's products go back to the seller unless you choose your own address"
        >
          <select value={f.returnTo} onChange={set("returnTo")}>
            <option value="">Where it was shipped from (seller or you)</option>
            <option value="own">Your own pickup address</option>
          </select>
        </Field>
        <details>
          <summary className="small">
            Package (leave blank to use the product's package type)
          </summary>
          <div className="row-4" style={{ marginTop: 6 }}>
            <Field label="Weight kg">
              <input
                type="number"
                step="0.1"
                value={f.weight}
                onChange={set("weight")}
              />
            </Field>
            <Field label="L cm">
              <input type="number" value={f.length} onChange={set("length")} />
            </Field>
            <Field label="B cm">
              <input
                type="number"
                value={f.breadth}
                onChange={set("breadth")}
              />
            </Field>
            <Field label="H cm">
              <input type="number" value={f.height} onChange={set("height")} />
            </Field>
          </div>
        </details>
        <Field
          label={
            manualOnly
              ? "AWB (booked on the courier's portal)"
              : "AWB — only if you booked it yourself on the courier's portal"
          }
        >
          <input
            value={f.awb}
            onChange={set("awb")}
            placeholder={
              manualOnly ? "required" : "leave blank to book through the API"
            }
          />
        </Field>
      </div>
    </Modal>
  );
}

function OrderModal({ id, couriers, onClose, onChanged, onShip, readOnly }) {
  const [o, setO] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [easyShip, setEasyShip] = useState(false);
  const { user } = useAuth();
  const [packOpen, setPackOpen] = useState(false);
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
  if (!o)
    return (
      <Modal open title="Order" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  const a = o.shippingAddress || {};
  const sh = o.shipment || {};
  const accName = couriers.find((c) => c._id === sh.account)?.name;
  const amz = o.channel === "amazon" ? o.amazon || {} : null;
  const isEasy = !!amz?.easyShip;
  const isEasyShipped = sh.carrier === "amazon_easyship";
  const fk = o.channel === "flipkart" ? o.flipkart || {} : null;
  const fkEkart = fk && fk.selfShip === false;
  return (
    <>
      {reverseOpen && (
        <ReverseModal
          order={o}
          couriers={couriers}
          onClose={() => setReverseOpen(false)}
          onDone={() => (setReverseOpen(false), load(), onChanged())}
        />
      )}
      {easyShip && (
        <EasyShipModal
          order={o}
          onClose={() => setEasyShip(false)}
          onDone={() => (setEasyShip(false), load(), onChanged())}
        />
      )}
      {packOpen && (
        <FlipkartPackModal
          order={o}
          onClose={() => setPackOpen(false)}
          onDone={() => (setPackOpen(false), load(), onChanged())}
        />
      )}
      <Modal
        open
        wide
        title={`Order ${o.name}`}
        onClose={onClose}
        footer={
          readOnly ? null : (
            <div className="order-actions">
              {fk &&
                !fkEkart &&
                ["new", "packed"].includes(o.status) &&
                fk.selfShip == null && (
                  <>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () =>
                            api.put(
                              `/flipkart-orders/orders/${o._id}/self-ship`,
                              { selfShip: false },
                            ),
                          "Marked: Flipkart picks it up",
                        )
                      }
                    >
                      Flipkart picks up
                    </button>
                  </>
                )}
              {fk && !fk.selfShip && ["new", "packed"].includes(o.status) && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => setPackOpen(true)}
                >
                  {fk.packedAt ? "Pack again" : "Pack & get label"}
                </button>
              )}
              {fk &&
                !fk.selfShip &&
                (fk.packedAt || o.status !== "new") &&
                o.status !== "cancelled" && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => openPdf(`/shopify/orders/${o._id}/label`)}
                  >
                    Flipkart label & invoice
                  </button>
                )}
              {fk && !fk.selfShip && o.status === "packed" && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.post(`/flipkart-orders/orders/${o._id}/rtd`),
                      "Ready to Dispatch on Flipkart",
                    )
                  }
                >
                  Ready to Dispatch
                </button>
              )}
              {fk && fk.selfShip && sh.awb && !fk.dispatchReportedAt && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api.post(
                          `/flipkart-orders/orders/${o._id}/report-dispatch`,
                        ),
                      "Dispatch reported to Flipkart",
                    )
                  }
                >
                  Report dispatch to Flipkart
                </button>
              )}
              {!fk && !o.invoice && o.status !== "cancelled" && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api.post("/shopify/orders/invoice", { ids: [o._id] }),
                      "Invoice created",
                    )
                  }
                >
                  Create Invoice
                </button>
              )}
              {["new", "packed"].includes(o.status) && !isEasy && !fkEkart && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => onShip([o._id])}
                >
                  {fk ? "Book own courier (self-ship)" : "Book Shipment"}
                </button>
              )}
              {["new", "packed"].includes(o.status) &&
                isEasy &&
                !isEasyShipped && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => setEasyShip(true)}
                  >
                    Schedule Easy Ship pickup
                  </button>
                )}
              {amz && !isEasy && sh.awb && !amz.confirmedAt && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.post(`/amazon-orders/orders/${o._id}/confirm`),
                      "Tracking sent to Amazon",
                    )
                  }
                >
                  Confirm on Amazon
                </button>
              )}
              {o.status === "new" && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api.post("/shopify/orders/status", {
                          ids: [o._id],
                          status: "packed",
                        }),
                      "Marked packed",
                    )
                  }
                >
                  Mark Packed
                </button>
              )}
              {(sh.awb || isEasyShipped) && (
                <button
                  className="btn"
                  onClick={() =>
                    openPdf(`/shopify/orders/${o._id}/label`).then(load)
                  }
                >
                  {isEasyShipped ? "Amazon label" : "Label"}
                </button>
              )}
              {sh.awb && !isEasyShipped && (
                <button
                  className="btn"
                  title="OrdexaGo's own 4x6 label (one per box), with COD, products and your return address"
                  onClick={() =>
                    openPdf("/shopify/orders/labels", {
                      ids: [o._id],
                      format: "4x6",
                    })
                  }
                >
                  OrdexaGo label
                </button>
              )}
              {sh.awb &&
                (sh.account || isEasyShipped) &&
                !["delivered", "rto", "cancelled"].includes(o.status) && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () =>
                          api.post("/shopify/orders/track", { ids: [o._id] }),
                        "Tracking updated",
                      )
                    }
                  >
                    Refresh Tracking
                  </button>
                )}
              {["shipped", "delivered", "return_created"].includes(o.status) &&
                (!o.channel || o.channel === "shopify") &&
                !(o.reverse?.awb && !o.reverse.deliveredAt) && (
                  <button
                    className="btn"
                    disabled={busy}
                    title="Damaged / wrong product or an approved return: the courier collects it from the customer"
                    onClick={() => setReverseOpen(true)}
                  >
                    Reverse Pickup
                  </button>
                )}
              {["shipped", "delivered"].includes(o.status) && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api.post("/shopify/orders/return", {
                          ids: [o._id],
                          action: "create",
                          note:
                            window.prompt("Reason for the return (optional)") ||
                            "",
                        }),
                      "Return created",
                    )
                  }
                >
                  Mark Return Created
                </button>
              )}
              {["rto", "return_created", "shipped", "delivered"].includes(
                o.status,
              ) && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(
                      `Close the return for ${o.name}? Do this when the parcel is back with you.`,
                    ) &&
                    act(
                      () =>
                        api.post("/shopify/orders/return", {
                          ids: [o._id],
                          action: "close",
                        }),
                      "Return closed",
                    )
                  }
                >
                  Mark Return Closed
                </button>
              )}
              {sh.awb &&
                ["ready_to_ship", "packed", "new"].includes(o.status) &&
                !isEasyShipped &&
                !readOnly && (
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    title="Cancels the AWB with the courier and the fulfilment in Shopify; the order goes back to Packed to book again"
                    onClick={() =>
                      window.confirm(
                        `Cancel shipment ${sh.awb}?\n\nIt's cancelled with ${sh.courierName || "the courier"} and the order is marked unfulfilled in Shopify. The order goes back to Packed, ready to book again.`,
                      ) &&
                      act(async () => {
                        let r;
                        try {
                          r = await api.post(
                            `/shopify/orders/${o._id}/cancel-shipment`,
                          );
                        } catch (e) {
                          if (!e.response?.data?.courierRefused) throw e;
                          if (
                            !window.confirm(
                              `${e.response.data.message}\n\nCancel it in OrdexaGo and Shopify anyway? You'll need to cancel the AWB on the courier's portal yourself.`,
                            )
                          )
                            return null;
                          r = await api.post(
                            `/shopify/orders/${o._id}/cancel-shipment`,
                            { force: true },
                          );
                        }
                        const note = [r.data?.courierNote, r.data?.shopifyNote]
                          .filter(Boolean)
                          .join(" · ");
                        toast(
                          note
                            ? `Shipment cancelled · ${note}`
                            : "Shipment cancelled",
                          /not cancelled|check it/.test(note)
                            ? "error"
                            : undefined,
                        );
                        return r;
                      })
                    }
                  >
                    Cancel Shipment
                  </button>
                )}
            </div>
          )
        }
      >
        <div className="order-head">
          <div>
            <span className={`status ship-${o.status}`}>
              {STATUS_LABEL[o.status]}
            </span>{" "}
            <PayBadge o={o} />{" "}
            <span className="muted small">
              {FIN[o.financialStatus] || o.financialStatus}
              {o.paymentMode === "partial"
                ? ` · ${money(o.prepaidAmount)} paid online, ${money(o.codAmount)} to collect on delivery`
                : o.paymentMode === "cod"
                  ? ` · collect ${money(o.codAmount || o.total)}`
                  : ""}
            </span>
          </div>
          <div className="muted small">
            {new Date(o.orderDate).toLocaleString("en-IN")}
          </div>
        </div>
        {o.reverse?.awb && (
          <ReverseBox
            o={o}
            readOnly={readOnly}
            onChanged={() => (load(), onChanged())}
          />
        )}
        {o.status === "returned" && (
          <div className="alert alert-info">
            Returned{o.returnedAt ? ` on ${date(o.returnedAt)}` : ""}
            {o.returnNote ? ` · ${o.returnNote}` : ""}
          </div>
        )}
        {fk && (
          <div className="alert alert-info" style={{ marginTop: 10 }}>
            <strong>
              Flipkart{" "}
              {fk.selfShip
                ? "self-ship"
                : fk.selfShip === false
                  ? "order — Flipkart's courier picks it up"
                  : "order"}
            </strong>
            {fk.dispatchBy && (
              <>
                {" "}
                · dispatch by{" "}
                {new Date(fk.dispatchBy).toLocaleString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </>
            )}
            {fk.state && (
              <> · on Flipkart: {fk.state.replace(/_/g, " ").toLowerCase()}</>
            )}
            {fk.hold && (
              <div className="text-red small">
                On hold at Flipkart — wait before packing.
              </div>
            )}
            {fk.selfShip == null && (
              <div className="small">
                Flipkart hasn't said how this ships. If Flipkart asked you to
                self-ship it, book your own courier; otherwise click "Flipkart
                picks up".
              </div>
            )}
            {fk.selfShip && fk.dispatchReportedAt && (
              <div className="small">
                Dispatch reported to Flipkart{" "}
                {new Date(fk.dispatchReportedAt).toLocaleString("en-IN")}
              </div>
            )}
            {fk.selfShip && fk.dispatchError && !fk.dispatchReportedAt && (
              <div className="text-red small">
                Flipkart wasn't told the dispatch: {fk.dispatchError}
              </div>
            )}
            <div className="muted small">
              Flipkart sales come into the books with the monthly Flipkart
              import, so no invoice is made here.
            </div>
          </div>
        )}
        {amz && (
          <div className="alert alert-info" style={{ marginTop: 10 }}>
            <strong>Amazon {isEasy ? "Easy Ship" : "self-ship"} order</strong>
            {amz.shipBy && (
              <>
                {" "}
                · ship by{" "}
                {new Date(amz.shipBy).toLocaleString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </>
            )}
            {amz.gstin && (
              <>
                {" "}
                · Amazon Business, GSTIN {amz.gstin}
                {amz.buyerCompany ? ` (${amz.buyerCompany})` : ""}
              </>
            )}
            {amz.slot && (
              <div className="small">
                Pickup {slotText(amz.slot)}
                {amz.packageStatus
                  ? ` · ${amz.packageStatus.replace(/([a-z])([A-Z])/g, "$1 $2")}`
                  : ""}
              </div>
            )}
            {amz.label?.state === "error" && (
              <div className="text-red small">{amz.label.error}</div>
            )}
            {!isEasy && amz.confirmedAt && (
              <div className="small">
                Tracking sent to Amazon{" "}
                {new Date(amz.confirmedAt).toLocaleString("en-IN")}
              </div>
            )}
            {!isEasy && amz.confirmError && !amz.confirmedAt && (
              <div className="text-red small">
                Amazon wasn't told the tracking number: {amz.confirmError}
              </div>
            )}
            {!o.shippingAddress?.address1 && (
              <div className="text-red small">
                No address from Amazon — give the app the Direct-to-Consumer
                Shipping role (Store → Amazon).
              </div>
            )}
          </div>
        )}
        {o.cancelledAt && (
          <div className="alert alert-error">
            Cancelled in {amz ? "Amazon" : "Shopify"} on {date(o.cancelledAt)}
            {o.cancelReason ? ` (${o.cancelReason.toLowerCase()})` : ""}
          </div>
        )}
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <div className="label-sm">Ship to</div>
            <strong>{a.name || o.customer?.name}</strong>
            <div>{[a.address1, a.address2].filter(Boolean).join(", ")}</div>
            <div>
              {a.city}, {a.province || stateName(a.state)} {a.zip}
            </div>
            <div>{a.phone || o.customer?.phone}</div>
            {o.customer?.email && (
              <div className="muted">{o.customer.email}</div>
            )}
          </div>
          <div>
            <div className="label-sm">Invoice</div>
            {o.invoice ? (
              <Link to={`/invoices/${o.invoice}`}>{o.invoiceNumber}</Link>
            ) : (
              <span className="muted">
                Not invoiced{o.invoiceError ? ` — ${o.invoiceError}` : ""}
              </span>
            )}
            {!readOnly && (
              <B2bBox o={o} onSaved={() => (load(), onChanged())} />
            )}
            {(!o.channel || o.channel === "shopify") &&
              !readOnly &&
              ["cod", "partial"].includes(o.paymentMode) &&
              ["new", "packed"].includes(o.status) &&
              !o.shipment?.awb && (
                <AdvanceBox o={o} onSaved={() => (load(), onChanged())} />
              )}
            {(!o.channel || o.channel === "shopify") && (
              <PaymentProofs
                orderId={o._id}
                canEdit={
                  !readOnly ||
                  (o.createdBy === user?._id &&
                    Date.now() - new Date(o.createdAt) < 30 * 60000)
                }
              />
            )}
            {o.createdByName && (
              <div className="muted small">
                Created in OrdexaGo by {o.createdByName}
              </div>
            )}
            <div className="label-sm" style={{ marginTop: 10 }}>
              Shipment
            </div>
            {sh.awb ? (
              <>
                <div>
                  {sh.courierName}
                  {accName && accName !== sh.courierName ? (
                    <span className="muted"> via {accName}</span>
                  ) : (
                    ""
                  )}
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
                {sh.trackStatus && (
                  <div className="muted small">
                    {TRACK_LABEL[sh.trackStatus] || sh.trackStatus}
                    {sh.trackedAt
                      ? ` · checked ${new Date(sh.trackedAt).toLocaleString("en-IN")}`
                      : ""}
                  </div>
                )}
                {sh.bookedAt && (
                  <div className="muted small">
                    Booked {new Date(sh.bookedAt).toLocaleString("en-IN")}
                  </div>
                )}
                {(o.extraShipments || []).length > 0 && (
                  <div className="small" style={{ margin: "6px 0" }}>
                    <strong>{(o.extraShipments || []).length + 1} boxes</strong>
                    {[sh, ...o.extraShipments].map((x, i) => (
                      <div
                        key={x.awb || i}
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          flexWrap: "wrap",
                          marginTop: 3,
                        }}
                      >
                        <span>
                          Box {x.box || i + 1}:{" "}
                          {x.trackingUrl ? (
                            <a
                              href={x.trackingUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {x.awb}
                            </a>
                          ) : (
                            x.awb
                          )}{" "}
                          ·{" "}
                          {TRACK_LABEL[x.trackStatus] ||
                            x.trackStatus ||
                            "booked"}
                          {x.codAmount ? ` · COD ${money(x.codAmount)}` : ""}
                          <span className="muted">
                            {" "}
                            ·{" "}
                            {(x.lines || [])
                              .map((l) => `${l.quantity} × ${l.title}`)
                              .join(", ")}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            openPdf(
                              `/shopify/orders/${o._id}/label${(x.box || i + 1) > 1 ? `?box=${x.box || i + 1}` : ""}`,
                            )
                          }
                        >
                          Label
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          title="OrdexaGo's own label for this box"
                          onClick={() =>
                            openPdf(
                              `/shopify/orders/${o._id}/label?own=1${(x.box || i + 1) > 1 ? `&box=${x.box || i + 1}` : ""}`,
                            )
                          }
                        >
                          OrdexaGo label
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {sh.carrier === "bluedart" && (
                  <div className="small">
                    {sh.refs?.token ? (
                      <span className="text-paid">
                        Pickup registered · token {sh.refs.token}
                        {sh.refs.pickupDate
                          ? ` · ${new Date(sh.refs.pickupDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}`
                          : ""}
                      </span>
                    ) : (
                      <span className="text-red">
                        Pickup not registered with Blue Dart
                        {sh.refs?.pickupError
                          ? ` — ${sh.refs.pickupError}`
                          : ""}
                      </span>
                    )}
                    {!readOnly && o.status === "ready_to_ship" && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginLeft: 8 }}
                        onClick={async () => {
                          try {
                            await api.post(`/shopify/orders/${o._id}/pickup`);
                            toast("Pickup registered with Blue Dart");
                          } catch (e) {
                            toast(errMsg(e), "error");
                          }
                          load();
                          onChanged();
                        }}
                      >
                        {sh.refs?.token ? "Register again" : "Register pickup"}
                      </button>
                    )}
                  </div>
                )}
                {o.awbScannedAt ? (
                  <div className="small text-paid">
                    AWB scanned (handed to courier){" "}
                    {new Date(o.awbScannedAt).toLocaleString("en-IN")}
                  </div>
                ) : (
                  ["ready_to_ship", "shipped", "delivered"].includes(
                    o.status,
                  ) && (
                    <div className="small text-amber">
                      AWB not scanned before handover
                    </div>
                  )
                )}
                {(o.awbScans || []).length > 1 && (
                  <div className="muted small">
                    Earlier scans:{" "}
                    {o.awbScans
                      .slice(0, -1)
                      .map(
                        (x) =>
                          `${x.awb} ${new Date(x.at).toLocaleString("en-IN")}`,
                      )
                      .join(" · ")}
                  </div>
                )}
                {sh.shopifyFulfilled && (
                  <div className="muted small">Marked fulfilled in Shopify</div>
                )}
                {sh.error && <div className="text-red small">{sh.error}</div>}
              </>
            ) : (
              <span className="muted">
                Not booked{sh.error ? ` — ${sh.error}` : ""}
              </span>
            )}
            {sh.awb && sh.charge != null && (
              <div className="muted small">
                Expected charge {money(sh.charge)} (
                {sh.chargeSource === "api" ? "API" : "rate card"})
                {sh.packageName ? ` · ${sh.packageName}` : ""}
              </div>
            )}
          </div>
        </div>
        {!sh.awb && !isEasy && ["new", "packed"].includes(o.status) && (
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
                  {l.image && (
                    <img
                      src={l.image}
                      alt=""
                      className="ship-thumb"
                      style={{ float: "left", marginRight: 8 }}
                    />
                  )}
                  {l.title}
                  {l.variantTitle && (
                    <span className="muted"> — {l.variantTitle}</span>
                  )}
                  {l.sku && <div className="muted small">SKU {l.sku}</div>}
                </td>
                <td>
                  {l.item ? (
                    <Link
                      to={`/items/${l.item._id}/edit`}
                      title={l.item.reviewNote}
                    >
                      {l.item.hsnSac || "No HSN"} · {l.item.taxRate}%
                      {l.item.needsReview && (
                        <span
                          className="pill pill-amber"
                          style={{ marginLeft: 6 }}
                        >
                          Check
                        </span>
                      )}
                    </Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {l.item?.reviewNote && (
                    <div className="muted small">{l.item.reviewNote}</div>
                  )}
                  {l.stock && l.item?.trackInventory && (
                    <div className="small">
                      Stock {l.stock.onHand}
                      {l.stock.racks.length > 0 && (
                        <>
                          {" "}
                          · pick from <b>{l.stock.racks.join(", ")}</b>
                        </>
                      )}
                      {l.stock.unassigned > 0 && (
                        <span className="muted">
                          {" "}
                          · {l.stock.unassigned} not on a rack
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="num">{l.quantity}</td>
                <td className="num">{money(l.unitPrice)}</td>
                <td className="num">
                  {money(l.total)}
                  {l.discount > 0 && (
                    <div className="muted small">
                      −{money(l.discount)} disc.
                    </div>
                  )}
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
                <strong>Total</strong>{" "}
                <span className="muted small">(GST inclusive)</span>
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
                  <span className="muted small">
                    {new Date(e.at).toLocaleString("en-IN")}
                  </span>{" "}
                  {e.status}
                  {e.location ? (
                    <span className="muted"> · {e.location}</span>
                  ) : (
                    ""
                  )}
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
        <WhatsAppLog orderId={o._id} />
        <Field label="Remarks (only in OrdexaGo)">
          <textarea
            rows={2}
            readOnly={readOnly}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            onBlur={() =>
              remarks !== (o.remarks || "") &&
              api
                .put(`/shopify/orders/${o._id}/remarks`, { remarks })
                .then(() => toast("Remarks saved"))
            }
          />
        </Field>
      </Modal>
    </>
  );
}

// WhatsApp order updates sent for this order (Marketing → Automations), and the buyer's COD answer.
const WA_STATUS = {
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  skipped: "Skipped",
  replied: "Replied",
};
function WhatsAppLog({ orderId }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState("");
  const load = () =>
    api
      .get(`/marketing/order-log/${orderId}`)
      .then((r) => setD(r.data))
      .catch(() => setD(null));
  useEffect(() => {
    load();
  }, [orderId]);
  if (!d || (!d.rows.length && !d.codConfirm)) return null;
  const canResend = can(user, ["marketing", "store_orders"], "full");
  const resend = async (event) => {
    setBusy(event);
    try {
      await api.post(`/marketing/order-log/${orderId}/resend`, { event });
      toast("Sent again on WhatsApp");
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div className="label-sm">WhatsApp updates</div>
      {d.codConfirm?.state && (
        <div
          className={`alert ${d.codConfirm.state === "confirmed" ? "alert-success" : "alert-warn"}`}
          style={{ margin: "6px 0" }}
        >
          {d.codConfirm.state === "confirmed"
            ? "Buyer confirmed this COD order on WhatsApp"
            : "Buyer asked to cancel this COD order on WhatsApp — check and cancel in Shopify if right"}{" "}
          ({new Date(d.codConfirm.at).toLocaleString("en-IN")})
        </div>
      )}
      <ul className="track-list">
        {d.rows.map((r) => (
          <li key={r._id}>
            <span className="muted small">
              {new Date(r.at).toLocaleString("en-IN")}
            </span>{" "}
            {d.events[r.event] || r.event} ·{" "}
            <span
              className={
                r.status === "failed"
                  ? "text-danger"
                  : r.status === "skipped"
                    ? "muted"
                    : ""
              }
            >
              {WA_STATUS[r.status] || r.status}
            </span>
            {r.error && <span className="muted small"> — {r.error}</span>}
            {canResend && ["failed", "skipped"].includes(r.status) && (
              <button
                className="link-btn"
                style={{ marginLeft: 8 }}
                disabled={!!busy}
                onClick={() => resend(r.event)}
              >
                {busy === r.event ? "Sending…" : "Send again"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewItems({ items, onClose, onChanged }) {
  return (
    <Modal
      open
      wide
      title="Items to check"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="muted small">
        These items were created from Shopify orders. OrdexaGo corrected the HSN
        or GST rate using your category rules, or couldn't tell the category.
        Open an item to fix it, or mark it checked.
      </p>
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
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    api.post(`/shopify/items/${i._id}/reviewed`).then(onChanged)
                  }
                >
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
  const { organization, organizations, user } = useAuth();
  // View-only (e.g. an order taker): no selecting, shipping, status changes or edits.
  const canAct = can(
    user,
    ["store_orders", "store_shipping", "store_returns"],
    "full",
  );
  const companyName = (id) =>
    (organizations || []).find((c) => String(c._id) === String(id))?.name ||
    "other company";
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "new";
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    seller: params.get("seller") || "",
    q: params.get("q") || "",
  }));
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1); // how many batches of 100 are shown (they load as you scroll)
  const [data, setData] = useState(null);
  const [store, setStore] = useState(null);
  const [amazon, setAmazon] = useState(null);
  const [flipkart, setFlipkart] = useState(null);
  const [returnedInShopify, setReturnedInShopify] = useState([]);
  const [easyShipFor, setEasyShipFor] = useState(null);
  const [couriers, setCouriers] = useState([]);
  const [facets, setFacets] = useState({ states: [], tags: [], financial: [] });
  const [sellers, setSellers] = useState([]);
  const brandSeller = useMemo(
    () =>
      new Map(
        sellers.flatMap((x) =>
          (x.brands || []).map((b) => [
            b.trim().toLowerCase().replace(/\s+/g, " "),
            x,
          ]),
        ),
      ),
    [sellers],
  );
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [ship, setShip] = useState(null);
  const [view, setView] = useState(() => params.get("open") || null); // ?open=<order id> (links from the Inbox)
  const [review, setReview] = useState([]);
  const [showReview, setShowReview] = useState(false);
  const q = useDebounced(filters.q, 300);
  const poll = useRef();
  const nav = useNavigate();

  const query = useMemo(() => {
    const p = { status: tab, page: 1, limit: 100 * page };
    for (const [k, v] of Object.entries({ ...filters, q })) if (v) p[k] = v;
    return p;
  }, [tab, page, filters, q]);

  // Only the latest request's answer is shown (an older, slower one can't overwrite it).
  const reqNo = useRef(0);
  const [loading, setLoading] = useState(false);
  const load = () => {
    const n = ++reqNo.current;
    setLoading(true);
    return api
      .get("/shopify/orders", { params: query })
      .then(
        (r) => n === reqNo.current && setData({ ...r.data, q: query.q || "" }),
      )
      .finally(() => n === reqNo.current && setLoading(false));
  };
  const loadReview = () =>
    api.get("/shopify/items/review").then((r) => setReview(r.data));
  const loadStore = () =>
    api.get("/shopify/store").then((r) => {
      setStore(r.data);
      return r.data;
    });

  const loadAmazon = () =>
    api
      .get("/amazon-orders/account")
      .then((r) => {
        setAmazon(r.data);
        return r.data;
      })
      .catch(() => null);
  useEffect(() => {
    api
      .get("/flipkart-orders/account")
      .then((r) => setFlipkart(r.data))
      .catch(() => {});
    api
      .get("/shopify/orders/returned-in-shopify")
      .then((r) => setReturnedInShopify(r.data))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadStore();
    loadAmazon();
    api.get("/shopify/couriers").then((r) => setCouriers(r.data));
    api.get("/shopify/orders/facets").then((r) => setFacets(r.data));
    api
      .get("/sellers")
      .then((r) => setSellers(r.data))
      .catch(() => {});
    loadReview();
    return () => clearTimeout(poll.current);
  }, []);
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    setSel(new Set());
  }, [query]);

  // A search with nothing in this tab: jump to the tab that has the match (or All Orders).
  useEffect(() => {
    if (!q || !data || data.q !== q || data.rows.length || !data.counts?.all)
      return;
    const hits = TABS.map(([k]) => k).filter(
      (k) => k !== "all" && data.counts[k] > 0,
    );
    const to = hits.length === 1 ? hits[0] : "all";
    if (to !== tab) setTab(to);
  }, [data]);

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

  const watchAmazon = () => {
    poll.current = setTimeout(async () => {
      const a = await loadAmazon();
      if (a?.sync?.running) watchAmazon();
      else {
        if (a?.sync?.error)
          toast(`Amazon sync failed: ${a.sync.error}`, "error");
        else if (a)
          toast(
            `Amazon: ${a.sync.created} new, ${a.sync.updated} updated${a.sync.invoiced ? `, ${a.sync.invoiced} invoiced` : ""}`,
          );
        load();
      }
    }, 1500);
  };
  const syncAmazon = async () => {
    try {
      await api.post("/amazon-orders/sync");
      setAmazon({ ...amazon, sync: { ...(amazon.sync || {}), running: true } });
      watchAmazon();
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
  const activeFilters = Object.entries(filters).filter(
    ([k, v]) => v && k !== "q" && !(k === "sort" && v === "newest"),
  ).length;

  const ids = [...sel];
  const rows = data?.rows || [];
  const toggleAll = () =>
    setSel(
      sel.size === rows.length ? new Set() : new Set(rows.map((r) => r._id)),
    );
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

  if (store && !store.connected && !store.shop && !amazon?.connected)
    return (
      <>
        <PageHeader title="Store" />
        <Empty
          icon="bag"
          title="Connect your Shopify store"
          text="Orders sync automatically, products become items with checked HSN and GST, and you can invoice and ship orders in one click."
          action={
            <Link className="btn btn-primary" to="/shopify-settings">
              Connect Shopify
            </Link>
          }
        />
      </>
    );

  const sync_ = store?.sync || {};
  return (
    <>
      <PageHeader
        title="Store"
        subtitle={
          store?.shopName
            ? `${store.shopName}${store.shared ? ` (shared from ${store.ownerName}) · invoices go to ${organization?.name}` : ""} · ${sync_.running ? "Syncing…" : store.lastSyncAt ? `Last synced ${new Date(store.lastSyncAt).toLocaleString("en-IN")}` : "Not synced yet"}${store.autoSync ? " · syncs every 15 min" : ""}`
            : ""
        }
      >
        <a
          className="btn"
          href={`/api/shopify/orders/export?${new URLSearchParams({ ...query, page: "" })}`}
          onClick={(e) => {
            e.preventDefault();
            api
              .get("/shopify/orders/export", {
                params: query,
                responseType: "blob",
              })
              .then((r) => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(r.data);
                a.download = "shopify-orders.csv";
                a.click();
              });
          }}
        >
          Export
        </a>
        <Link className="btn" to="/awb-scan">
          Scan AWB
        </Link>
        <Link className="btn" to="/returns-scan">
          Scan Returns
        </Link>
        <Link className="btn" to="/shopify-settings">
          <Icon name="settings" size={16} /> Settings
        </Link>
        {amazon?.connected && (
          <button
            className="btn"
            disabled={amazon.sync?.running}
            onClick={syncAmazon}
            title={
              amazon.lastSyncAt
                ? `Amazon last synced ${new Date(amazon.lastSyncAt).toLocaleString("en-IN")}`
                : ""
            }
          >
            {amazon.sync?.running
              ? `Amazon… ${amazon.sync.fetched || 0}`
              : "Sync Amazon"}
          </button>
        )}
        {store?.connected && can(user, "store_orders.new_order", "full") && (
          <Link className="btn" to="/shopify-orders/new">
            + New order
          </Link>
        )}
        {(store?.connected || store?.shop) && (
          <button
            className="btn btn-primary"
            disabled={sync_.running || !store?.connected}
            onClick={sync}
          >
            {sync_.running ? `Syncing… ${sync_.fetched || 0}` : "Sync Orders"}
          </button>
        )}
      </PageHeader>

      {returnedInShopify.length > 0 && (
        <div className="alert alert-warn" style={{ marginBottom: 12 }}>
          <strong>
            {returnedInShopify.length} order
            {returnedInShopify.length > 1 ? "s were" : " was"} returned in
            Shopify but still show as Shipped here
          </strong>{" "}
          (
          {returnedInShopify
            .slice(0, 8)
            .map((o) => o.name)
            .join(", ")}
          {returnedInShopify.length > 8 ? "…" : ""}). Closing them marks them
          Returned, posts a credit note against each one's OrdexaGo invoice and
          puts the stock back.{" "}
          <button
            className="btn btn-sm"
            onClick={async () => {
              if (
                !window.confirm(
                  `Close ${returnedInShopify.length} returns?\n\nEach order becomes Returned; a credit note is posted against its OrdexaGo invoice (${returnedInShopify.filter((o) => o.invoiceNumber).length} invoices) and its stock is put back.`,
                )
              )
                return;
              try {
                const { data } = await api.post(
                  "/shopify/orders/returned-in-shopify/close",
                );
                toast(
                  `${data.closed} returns closed · ${data.creditNotes.length} credit notes${data.failed.length ? ` · ${data.failed.length} failed: ${data.failed.slice(0, 2).join("; ")}` : ""}`,
                  data.failed.length ? "error" : undefined,
                );
                setReturnedInShopify([]);
                load();
              } catch (e) {
                toast(errMsg(e), "error");
              }
            }}
          >
            Close {returnedInShopify.length} returns
          </button>
        </div>
      )}
      {flipkart && flipkart.appId && !flipkart.connected && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          Flipkart isn't connected.{" "}
          {flipkart.sync?.error && <>Last error: {flipkart.sync.error}. </>}
          <Link to="/flipkart-settings">Check the connection</Link>
        </div>
      )}
      {amazon && amazon.clientId && !amazon.connected && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          Amazon isn't connected.{" "}
          {amazon.sync?.error && <>Last error: {amazon.sync.error}. </>}
          <Link to="/amazon-settings">Check the connection</Link>
        </div>
      )}
      {store && store.shop && !store.connected && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          Shopify isn't connected.{" "}
          {sync_.error && <>Last error: {sync_.error}. </>}
          <Link to="/shopify-settings">Check the connection</Link>
        </div>
      )}
      {review.length > 0 && (
        <div
          className="alert alert-warn"
          style={{ marginBottom: 12, marginTop: 0 }}
        >
          {review.length} item{review.length === 1 ? "" : "s"} created from
          Shopify had the HSN or GST rate corrected, or need a check.{" "}
          <button className="link-btn" onClick={() => setShowReview(true)}>
            Review items
          </button>
        </div>
      )}

      <div className="tabs ship-tabs">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            className={`tab ${tab === k ? "active" : ""}`}
            onClick={() => setTab(k)}
          >
            {l} <span className="tab-count">{data?.counts?.[k] ?? ""}</span>
          </button>
        ))}
      </div>

      <div className="card flush">
        <div className="filter-bar">
          <SearchBox
            value={filters.q}
            onChange={(v) => setFilters({ ...filters, q: v })}
            placeholder="Order no, customer, phone, AWB, SKU, pincode…"
          />
          <input
            type="date"
            value={filters.from}
            onChange={setF("from")}
            title="From"
          />
          <span className="muted">to</span>
          <input
            type="date"
            value={filters.to}
            onChange={setF("to")}
            title="To"
          />
          {(amazon?.connected || flipkart?.connected) && (
            <select value={filters.channel} onChange={setF("channel")}>
              <option value="">All channels</option>
              <option value="shopify">Shopify</option>
              {amazon?.connected && (
                <>
                  <option value="amazon">Amazon (all)</option>
                  <option value="amazon_self">Amazon self-ship</option>
                  <option value="amazon_easyship">Amazon Easy Ship</option>
                </>
              )}
              {flipkart?.connected && (
                <>
                  <option value="flipkart">Flipkart (all)</option>
                  <option value="flipkart_ekart">Flipkart logistics</option>
                  <option value="flipkart_self">Flipkart self-ship</option>
                </>
              )}
            </select>
          )}
          <select value={filters.payment} onChange={setF("payment")}>
            <option value="">All payment types</option>
            <option value="cod">COD</option>
            <option value="prepaid">Prepaid</option>
            <option value="partial">Partly paid</option>
          </select>
          {sellers.length > 0 && (
            <select value={filters.seller} onChange={setF("seller")}>
              <option value="">All sellers</option>
              <option value="own">Our own products</option>
              {sellers.map((x) => (
                <option key={x._id} value={x._id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          <button
            className={`btn btn-sm ${showFilters || activeFilters ? "btn-active" : ""}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            More filters{activeFilters ? ` (${activeFilters})` : ""}
          </button>
          {(activeFilters > 0 || filters.q) && (
            <button
              className="link-btn small"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
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

        {canAct && sel.size > 0 && (
          <div className="bulk-bar">
            <strong>{sel.size} selected</strong>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() =>
                bulk("/shopify/orders/invoice", { ids }, "Invoices")
              }
            >
              Generate Invoices
            </button>
            {["new", "packed", "all"].includes(tab) && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => setShip(ids)}
              >
                Book Shipment
              </button>
            )}
            {["new", "all"].includes(tab) && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  bulk(
                    "/shopify/orders/status",
                    { ids, status: "packed" },
                    "Mark packed",
                  )
                }
              >
                Mark Packed
              </button>
            )}
            {[
              "ready_to_ship",
              "awb_scanned",
              "shipped",
              "delivered",
              "rto",
              "all",
            ].includes(tab) && (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    openPdf("/shopify/orders/labels", { ids, format: "4x6" })
                  }
                >
                  Labels 4x6
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    openPdf("/shopify/orders/labels", { ids, format: "a4" })
                  }
                >
                  Labels A4
                </button>
              </>
            )}
            {["ready_to_ship", "awb_scanned", "shipped", "all"].includes(
              tab,
            ) && (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    bulk("/shopify/orders/track", { ids }, "Tracking")
                  }
                >
                  Refresh Tracking
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    bulk(
                      "/shopify/orders/status",
                      { ids, status: "shipped" },
                      "Mark shipped",
                    )
                  }
                >
                  Mark Shipped
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    bulk(
                      "/shopify/orders/status",
                      { ids, status: "delivered" },
                      "Mark delivered",
                    )
                  }
                >
                  Mark Delivered
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    bulk(
                      "/shopify/orders/status",
                      { ids, status: "rto" },
                      "Mark RTO",
                    )
                  }
                >
                  Mark RTO
                </button>
              </>
            )}
            {["shipped", "delivered", "all"].includes(tab) && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  bulk(
                    "/shopify/orders/return",
                    { ids, action: "create" },
                    "Returns created",
                  )
                }
              >
                Mark Return Created
              </button>
            )}
            {["rto", "return_created", "shipped", "delivered", "all"].includes(
              tab,
            ) && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  bulk(
                    "/shopify/orders/return",
                    { ids, action: "close" },
                    "Returns closed",
                  )
                }
              >
                Mark Return Closed
              </button>
            )}
            {tab === "packed" && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() =>
                  bulk(
                    "/shopify/orders/status",
                    { ids, status: "new" },
                    "Move to New",
                  )
                }
              >
                Move to New
              </button>
            )}
          </div>
        )}

        {!data ? (
          <Spinner />
        ) : !rows.length ? (
          <div className="empty-row muted">
            {data.counts.all
              ? "No orders match."
              : store?.connected
                ? "No orders yet — click Sync Orders."
                : "No orders."}
          </div>
        ) : (
          <table
            className="table table-click ship-table"
            style={{
              opacity: loading && page === 1 ? 0.55 : 1,
              transition: "opacity .15s",
            }}
          >
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={sel.size === rows.length}
                    onChange={toggleAll}
                  />
                </th>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Payment</th>
                <th>
                  {tab === "new" || tab === "packed"
                    ? "Destination"
                    : "Shipment"}
                </th>
                <th>Invoice</th>
                {tab === "all" && <th>Status</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                let items = (o.lines || []).filter((l) => l.quantity > 0);
                // Marketplace sellers on this order: their products first when filtering by that seller, and a tag.
                const sellerOf = (l) =>
                  brandSeller.get(
                    String(l.vendor || "")
                      .trim()
                      .toLowerCase()
                      .replace(/\s+/g, " "),
                  );
                if (filters.seller && filters.seller !== "own")
                  items = [...items].sort(
                    (a, b) =>
                      (sellerOf(b)?._id === filters.seller) -
                      (sellerOf(a)?._id === filters.seller),
                  );
                const tags = [
                  ...new Map(
                    items
                      .map((l) => sellerOf(l))
                      .filter(Boolean)
                      .map((x) => [x._id, x]),
                  ).values(),
                ].map((x) => ({
                  name: x.name,
                  n: items.filter((l) => sellerOf(l)?._id === x._id).length,
                }));
                const sh = o.shipment || {};
                return (
                  <tr
                    key={o._id}
                    onClick={() => setView(o._id)}
                    className={sel.has(o._id) ? "selected" : ""}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={sel.has(o._id)}
                        onChange={() => toggle(o._id)}
                      />
                    </td>
                    <td>
                      <strong>{o.name}</strong>
                      {(o.channel === "amazon" || o.channel === "flipkart") && (
                        <div>
                          <AmazonBadge o={o} />
                        </div>
                      )}
                      <div className="muted small">
                        {new Date(o.orderDate).toLocaleString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td>
                      {o.customer?.name}
                      <div className="muted small">{o.customer?.phone}</div>
                    </td>
                    <td className="small">
                      <div className="ship-items">
                        {items[0]?.image ? (
                          <img
                            src={items[0].image}
                            alt=""
                            className="ship-thumb"
                            loading="lazy"
                          />
                        ) : (
                          <div className="ship-thumb empty" />
                        )}
                        <div>
                          {items.slice(0, 2).map((l, i) => (
                            <div key={i} className="ellipsis">
                              {l.quantity} × {l.title}
                              {l.variantTitle ? ` (${l.variantTitle})` : ""}
                              {l.sku && (
                                <span className="muted"> · {l.sku}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                      {items.length > 2 && (
                        <div className="muted">+{items.length - 2} more</div>
                      )}
                      {tags.map((t) => (
                        <div
                          key={t.name}
                          className="small"
                          style={{ marginTop: 2 }}
                        >
                          <span className="status status-sent">
                            {t.name}: {t.n} of {items.length} item
                            {items.length > 1 ? "s" : ""}
                          </span>
                        </div>
                      ))}
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
                            <a
                              href={sh.trackingUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {sh.awb}
                            </a>
                          ) : (
                            <div>{sh.awb}</div>
                          )}
                          {sh.trackStatus && (
                            <div className="muted">
                              {o.status === "return_created"
                                ? "Delivery: "
                                : ""}
                              {TRACK_LABEL[sh.trackStatus] || sh.trackStatus}
                            </div>
                          )}
                          {o.status === "return_created" && (
                            <div className="small" style={{ color: "#b45309" }}>
                              {o.returnStatus === "RETURN_REQUESTED"
                                ? "Return requested in Shopify"
                                : "Return open in Shopify"}
                            </div>
                          )}
                          {o.awbScannedAt && (
                            <div className="muted small">
                              Scanned{" "}
                              {new Date(o.awbScannedAt).toLocaleString(
                                "en-IN",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </div>
                          )}
                          {sh.error &&
                            /cancelled in Shopify/.test(sh.error) && (
                              <div className="text-red small">
                                Fulfilment cancelled in Shopify
                              </div>
                            )}
                        </>
                      ) : (
                        <>
                          {o.shippingAddress?.city}
                          <div className="muted">
                            {o.shippingAddress?.province ||
                              stateName(o.shippingAddress?.state)}{" "}
                            {o.shippingAddress?.zip}
                          </div>
                        </>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {o.invoice ? (
                        o.invoiceOrg &&
                        String(o.invoiceOrg) !== String(organization?._id) ? (
                          <span title="Invoiced in your other company">
                            {o.invoiceNumber}{" "}
                            <span className="muted small">
                              ({companyName(o.invoiceOrg)})
                            </span>
                          </span>
                        ) : (
                          <Link to={`/invoices/${o.invoice}`}>
                            {o.invoiceNumber}
                          </Link>
                        )
                      ) : o.status !== "cancelled" ? (
                        <button
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() =>
                            bulk(
                              "/shopify/orders/invoice",
                              { ids: [o._id] },
                              "Invoice",
                            )
                          }
                        >
                          Invoice
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {tab === "all" && (
                      <td>
                        <span className={`status ship-${o.status}`}>
                          {STATUS_LABEL[o.status]}
                        </span>
                      </td>
                    )}
                    <td
                      onClick={(e) => e.stopPropagation()}
                      className="row-btns"
                    >
                      {canAct &&
                        ["new", "packed"].includes(o.status) &&
                        !(o.channel === "amazon" && o.amazon?.easyShip) &&
                        !(
                          o.channel === "flipkart" &&
                          o.flipkart?.selfShip === false
                        ) && (
                          <button
                            className="btn btn-sm"
                            onClick={() => setShip([o._id])}
                          >
                            Ship
                          </button>
                        )}
                      {canAct &&
                        ["new", "packed"].includes(o.status) &&
                        o.channel === "amazon" &&
                        o.amazon?.easyShip &&
                        sh.carrier !== "amazon_easyship" && (
                          <button
                            className="btn btn-sm"
                            onClick={() => setEasyShipFor(o)}
                            title="Schedule Amazon's pickup"
                          >
                            Easy Ship
                          </button>
                        )}
                      {(sh.awb ||
                        sh.carrier === "amazon_easyship" ||
                        (o.channel === "flipkart" &&
                          !o.flipkart?.selfShip &&
                          o.status !== "new")) && (
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            openPdf(`/shopify/orders/${o._id}/label`)
                          }
                        >
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
        {data && data.total > 0 && (
          <MoreOrders
            shown={data.rows.length}
            total={data.total}
            loading={loading}
            onMore={() =>
              !loading && data.rows.length < data.total && setPage(page + 1)
            }
          />
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
      {results && (
        <ResultsModal {...results} onClose={() => setResults(null)} />
      )}
      {easyShipFor && (
        <EasyShipModal
          order={easyShipFor}
          onClose={() => setEasyShipFor(null)}
          onDone={() => (setEasyShipFor(null), load())}
        />
      )}
      {view && (
        <OrderModal
          id={view}
          couriers={couriers}
          readOnly={!canAct}
          onClose={() => setView(null)}
          onChanged={load}
          onShip={(i) => setShip(i)}
        />
      )}
      {showReview && (
        <ReviewItems
          items={review}
          onClose={() => setShowReview(false)}
          onChanged={loadReview}
        />
      )}
      {void nav}
    </>
  );
}

// All orders in one list: the next 100 load on their own as you scroll to the bottom (selections stay).
function MoreOrders({ shown, total, loading, onMore }) {
  const ref = useRef();
  useEffect(() => {
    if (!ref.current || shown >= total) return;
    const io = new IntersectionObserver(
      (e) => e[0].isIntersecting && onMore(),
      { rootMargin: "400px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown, total, loading]);
  return (
    <div ref={ref} className="pager">
      <span className="muted small">
        Showing {shown} of {total}
      </span>
      {shown < total && (
        <button className="btn btn-sm" disabled={loading} onClick={onMore}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

// Booking: is it prepaid, COD or partly paid — shown big, before choosing the courier.
function PaymentBanner({ orders }) {
  if (!orders?.length) return null;
  const kind = (o) =>
    o.paymentMode === "partial"
      ? "partial"
      : o.codAmount > 0
        ? "cod"
        : "prepaid";
  if (orders.length === 1) {
    const o = orders[0];
    const k = kind(o);
    return (
      <div
        className={`alert ${k === "prepaid" ? "alert-success" : "alert-warn"}`}
        style={{ fontSize: 15 }}
      >
        <b>
          {k === "prepaid" ? "PREPAID" : k === "cod" ? "COD" : "PARTLY PAID"}
        </b>
        {" · "}
        {k === "prepaid"
          ? `nothing to collect (order ${money(o.orderTotal)})`
          : k === "cod"
            ? `collect ${money(o.codAmount)} on delivery`
            : `${money(o.prepaidAmount)} paid online · collect ${money(o.codAmount)} on delivery`}
      </div>
    );
  }
  const n = { prepaid: 0, cod: 0, partial: 0 };
  let collect = 0;
  for (const o of orders) {
    n[kind(o)]++;
    collect += o.codAmount || 0;
  }
  return (
    <div className="alert alert-info">
      <b>{n.prepaid} prepaid</b> · <b>{n.cod} COD</b>
      {n.partial ? (
        <>
          {" "}
          · <b>{n.partial} partly paid</b>
        </>
      ) : null}
      {collect > 0 && ` · ${money(collect)} to collect`}
      <div className="small muted">
        With separate COD and prepaid accounts for a courier (e.g. Blue Dart),
        each order is booked with the right one, whichever you pick.
      </div>
    </div>
  );
}
