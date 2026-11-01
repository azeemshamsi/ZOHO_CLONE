import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader, Spinner, Modal, Field, SearchBox, useDebounced, toast } from "../components/ui";
import Icon from "../components/Icon";

const TABS = [
  ["all", "All"],
  ["in", "In Stock"],
  ["out", "Out of Stock"],
  ["virtual", "Virtual Stock"],
  ["oversold", "Over Sold"],
];
const num = (n) => (Number.isInteger(n) ? n : Number(n || 0).toFixed(2));

function RacksModal({ racks, warehouses, onClose, onChanged }) {
  const [codes, setCodes] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const add = async () => {
    try {
      const { data } = await api.post("/stock/racks", { codes, warehouse: warehouse || null });
      toast(`${data.created} rack${data.created === 1 ? "" : "s"} added`);
      setCodes("");
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const whName = (id) => warehouses.find((w) => w._id === id)?.name || "Primary";
  return (
    <Modal open title="Racks" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p className="muted small">Racks (bins) inside a warehouse. Put stock away into racks from an item; sales take stock off racks automatically, starting with the first rack.</p>
      <div className="row-actions" style={{ alignItems: "end" }}>
        <Field label="Add racks" hint="e.g. A1, A2 or a range A01-A20">
          <input value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="A01-A20" />
        </Field>
        {warehouses.length > 1 && (
          <Field label="Warehouse">
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">Primary</option>
              {warehouses.filter((w) => !w.primary).map((w) => (
                <option key={w._id} value={w._id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button className="btn btn-primary" disabled={!codes.trim()} onClick={add} style={{ marginBottom: 18 }}>
          Add
        </button>
      </div>
      <div className="rack-chips">
        {racks.map((r) => (
          <span key={r._id} className={`chip ${r.active ? "" : "muted"}`} title={whName(r.warehouse)}>
            {r.code}
            {warehouses.length > 1 && <small> · {whName(r.warehouse)}</small>}
          </span>
        ))}
        {!racks.length && <span className="muted">No racks yet.</span>}
      </div>
    </Modal>
  );
}

function LinkPicker({ item, onClose, onSaved }) {
  const [q, setQ] = useState(item.sku || item.name.split(" ").slice(0, 2).join(" "));
  const dq = useDebounced(q, 400);
  const [found, setFound] = useState(null);
  const [links, setLinks] = useState(item.links || []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFound(null);
    api
      .get("/stock/shopify/variants", { params: { q: dq } })
      .then((r) => setFound(r.data))
      .catch((e) => {
        toast(errMsg(e), "error");
        setFound([]);
      });
  }, [dq]);
  const has = (v) => links.some((l) => l.variantId === v.variantId);
  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.put(`/stock/${item._id}/links`, { links });
      toast(data.retired.length ? `Linked. ${data.retired.map((r) => `${r.name} (${r.orders} open orders moved)`).join(", ")} now use ${item.name}` : "Links saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      wide
      title={`Shopify listings for ${item.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            Save Links
          </button>
        </>
      }
    >
      <p className="muted small">
        Linked listings are virtual: their orders use <strong>{item.name}</strong>'s stock, and its stock is pushed to every linked listing. Only {item.name} appears in the books.
      </p>
      <div className="link-cols">
        <div>
          <SearchBox value={q} onChange={setQ} placeholder="Search Shopify by title or SKU" />
          <div className="link-list">
            {found === null ? (
              <Spinner />
            ) : !found.length ? (
              <p className="muted small">Nothing found.</p>
            ) : (
              found.map((v) => (
                <label key={v.variantId} className={`link-row ${has(v) ? "on" : ""}`}>
                  <input type="checkbox" checked={has(v)} disabled={v.variantId === item.shopifyVariantId} onChange={(e) => setLinks(e.target.checked ? [...links, v] : links.filter((l) => l.variantId !== v.variantId))} />
                  {v.image ? <img src={v.image} alt="" className="ship-thumb" /> : <span className="ship-thumb empty" />}
                  <span>
                    {v.title}
                    <small className="muted"> {v.sku}</small>
                    {v.variantId === item.shopifyVariantId && <small className="muted"> (this item's own listing)</small>}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="label-sm">Linked ({links.length})</div>
          {links.map((l) => (
            <div key={l.variantId} className="link-row on">
              <span>
                {l.title}
                <small className="muted"> {l.sku}</small>
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => setLinks(links.filter((x) => x.variantId !== l.variantId))}>
                ✕
              </button>
            </div>
          ))}
          {!links.length && <p className="muted small">None yet.</p>}
        </div>
      </div>
    </Modal>
  );
}

function ItemStock({ id, racks, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [mv, setMv] = useState({ from: "", to: "", qty: "" });
  const [links, setLinks] = useState(false);
  const load = () =>
    api.get(`/stock/${id}`).then((r) => {
      setD(r.data);
      setF({ virtualStock: r.data.virtual, bufferStock: r.data.buffer, shopifySync: r.data.shopifySync, trackInventory: r.data.trackInventory, weight: r.data.weight, category: r.data.category });
    });
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [id]);
  if (!d) return <Modal open title="Item" onClose={onClose}><Spinner /></Modal>;
  const save = async () => {
    try {
      await api.put(`/stock/${id}`, { ...f, virtualStock: Number(f.virtualStock) || 0, bufferStock: Number(f.bufferStock) || 0, weight: Number(f.weight) || 0 });
      toast("Saved");
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const move = async () => {
    try {
      await api.post("/stock/moves", { item: id, from: mv.from || null, to: mv.to || null, qty: Number(mv.qty) });
      toast(mv.from && mv.to ? "Moved" : mv.to ? "Put away" : "Taken off the rack");
      setMv({ from: "", to: "", qty: "" });
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const unassigned = d.unassigned.reduce((s, u) => s + u.qty, 0);
  return (
    <Modal
      open
      wide
      title={d.name}
      onClose={onClose}
      footer={
        <>
          <Link className="btn" to={`/items/${id}`}>
            Item & History
          </Link>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="inv-head">
        {d.image ? <img src={d.image} alt="" className="inv-img" /> : <div className="inv-img empty" />}
        <div className="inv-stats">
          <div>
            <span className="label-sm">In stock</span>
            <strong>{num(d.onHand)}</strong>
          </div>
          <div>
            <span className="label-sm">Blocked</span>
            <strong>{num(d.blocked)}</strong>
          </div>
          <div>
            <span className="label-sm">Buffer</span>
            <strong>{num(d.buffer)}</strong>
          </div>
          <div>
            <span className="label-sm">Virtual</span>
            <strong>{num(d.virtual)}</strong>
          </div>
          <div>
            <span className="label-sm">On Shopify</span>
            <strong>{d.shopify ?? "—"}</strong>
          </div>
        </div>
      </div>
      <p className="muted small">
        SKU {d.sku || "—"} · HSN {d.hsnSac || "—"} · GST {d.taxRate}% · Value {money(d.value)}
      </p>

      <div className="grid-2">
        <div>
          <div className="label-sm">Where it is</div>
          {d.warehouses.length > 1 && (
            <div className="small" style={{ marginBottom: 6 }}>
              {d.warehouses.map((w) => `${w.warehouseName}: ${num(w.qty)}`).join(" · ")}
            </div>
          )}
          <div className="rack-chips">
            {d.racks.map((r) => (
              <span key={r.rack} className="chip">
                {r.code} <b>{num(r.qty)}</b>
              </span>
            ))}
            {unassigned !== 0 && <span className={`chip ${unassigned < 0 ? "chip-red" : "chip-amber"}`}>Not on a rack <b>{num(unassigned)}</b></span>}
            {!d.racks.length && !unassigned && <span className="muted small">No stock</span>}
          </div>
          {d.trackInventory && racks.length > 0 && (
            <div className="move-box">
              <div className="row-3">
                <select value={mv.from} onChange={(e) => setMv({ ...mv, from: e.target.value })}>
                  <option value="">From: not on a rack</option>
                  {d.racks.map((r) => (
                    <option key={r.rack} value={r.rack}>
                      From {r.code} ({num(r.qty)})
                    </option>
                  ))}
                </select>
                <select value={mv.to} onChange={(e) => setMv({ ...mv, to: e.target.value })}>
                  <option value="">{mv.from ? "To: off the rack" : "To rack…"}</option>
                  {racks.filter((r) => r.active).map((r) => (
                    <option key={r._id} value={r._id}>
                      To {r.code}
                    </option>
                  ))}
                </select>
                <input type="number" min="0" placeholder="Qty" value={mv.qty} onChange={(e) => setMv({ ...mv, qty: e.target.value })} />
              </div>
              <button className="btn btn-sm" disabled={!Number(mv.qty) || (!mv.from && !mv.to)} onClick={move}>
                {mv.from && mv.to ? "Move" : mv.from ? "Take off rack" : "Put away"}
              </button>
            </div>
          )}
        </div>
        <div>
          <div className="label-sm">Shopify</div>
          <label className="switch-row">
            <input type="checkbox" checked={f.shopifySync} onChange={(e) => setF({ ...f, shopifySync: e.target.checked })} />
            <span>Sync stock to Shopify</span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={f.trackInventory} onChange={(e) => setF({ ...f, trackInventory: e.target.checked })} />
            <span>Track inventory</span>
          </label>
          <div className="row-3">
            <Field label="Virtual stock" hint="Made to order; not in the books">
              <input type="number" min="0" value={f.virtualStock} onChange={(e) => setF({ ...f, virtualStock: e.target.value })} />
            </Field>
            <Field label="Buffer" hint="Kept back from Shopify">
              <input type="number" min="0" value={f.bufferStock} onChange={(e) => setF({ ...f, bufferStock: e.target.value })} />
            </Field>
            <Field label="Weight (kg)">
              <input type="number" min="0" step="0.01" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} />
            </Field>
          </div>
          <div className="small">
            {d.shopifyVariantId ? "Own Shopify listing" : "No own Shopify listing"} · {d.links.length} linked listing{d.links.length === 1 ? "" : "s"}{" "}
            <button className="link-btn small" onClick={() => setLinks(true)}>
              Manage links
            </button>
          </div>
          {d.links.length > 0 && (
            <ul className="plain-list small">
              {d.links.map((l) => (
                <li key={l.variantId}>
                  {l.title} <span className="muted">{l.sku}</span> {d.pushed?.[l.variantId] !== undefined && <span className="muted">· Shopify {d.pushed[l.variantId]}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {d.reservedBy.length > 0 && (
        <>
          <div className="label-sm" style={{ marginTop: 12 }}>
            Reserved by Shopify orders (not invoiced yet)
          </div>
          <div className="small">
            {d.reservedBy.map((o) => (
              <Link key={o._id} to={`/shopify-orders?tab=all`} className="chip">
                {o.name} × {o.qty}
              </Link>
            ))}
          </div>
        </>
      )}
      {d.moves.length > 0 && (
        <>
          <div className="label-sm" style={{ marginTop: 12 }}>
            Rack history
          </div>
          <ul className="plain-list small">
            {d.moves.slice(0, 10).map((m) => (
              <li key={m._id}>
                <span className="muted">{new Date(m.createdAt).toLocaleString("en-IN")}</span> {num(m.qty)} {m.from ? `from ${m.from.code}` : "put away"} {m.to ? `to ${m.to.code}` : "off rack"} {m.user && <span className="muted">· {m.user}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {links && (
        <LinkPicker
          item={d}
          onClose={() => setLinks(false)}
          onSaved={() => {
            setLinks(false);
            load();
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

export function Inventory() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "all";
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [filters, setFilters] = useState({ category: "", rack: "", sync: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [view, setView] = useState(null);
  const [showRacks, setShowRacks] = useState(false);
  const [pushing, setPushing] = useState(false);
  const query = useMemo(() => ({ tab, page, q: dq || undefined, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }), [tab, page, dq, filters]);
  const load = () => api.get("/stock", { params: query }).then((r) => setData(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [query]);
  const push = async () => {
    setPushing(true);
    try {
      const { data: r } = await api.post("/stock/shopify/push", { force: true });
      toast(r.errors?.length ? `Pushed ${r.pushed}; ${r.errors[0]}` : `Sent ${r.pushed} stock levels to Shopify`, r.errors?.length ? "error" : "success");
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setPushing(false);
  };
  const quickSync = async (r, on) => {
    await api.put(`/stock/${r._id}`, { shopifySync: on });
    load();
  };
  const sync = data?.sync;
  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle={
          sync?.on ? (
            <>
              Stock syncs to Shopify ({sync.location}) automatically
              {sync.status?.at ? ` · last sent ${new Date(sync.status.at).toLocaleString("en-IN")}` : ""}
              {sync.status?.errors?.length ? <span className="text-red"> · {sync.status.errors[0]}</span> : ""}
            </>
          ) : (
            <>
              Shopify inventory sync is off. <Link to="/shopify-settings#inventory">Turn it on</Link>
            </>
          )
        }
      >
        <button className="btn" onClick={() => setShowRacks(true)}>
          Racks
        </button>
        <button
          className="btn"
          onClick={() =>
            api.get("/stock/export", { responseType: "blob" }).then((r) => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(r.data);
              a.download = "inventory.csv";
              a.click();
            })
          }
        >
          Export
        </button>
        {sync?.on && (
          <button className="btn btn-primary" disabled={pushing} onClick={push}>
            {pushing ? "Sending…" : "Push to Shopify"}
          </button>
        )}
      </PageHeader>

      <div className="tabs ship-tabs">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            className={`tab ${tab === k ? "active" : ""}`}
            onClick={() => {
              setParams(k === "all" ? {} : { tab: k });
              setPage(1);
            }}
          >
            {l} <span className={`tab-count ${k === "oversold" && data?.counts?.oversold ? "red" : ""}`}>{data?.counts?.[k] ?? ""}</span>
          </button>
        ))}
      </div>

      <div className="card flush">
        <div className="filter-bar">
          <SearchBox value={q} onChange={setQ} placeholder="SKU, name, HSN, rack, linked SKU…" />
          <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
            <option value="">All categories</option>
            {(data?.categories || []).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={filters.rack} onChange={(e) => setFilters({ ...filters, rack: e.target.value })}>
            <option value="">All racks</option>
            {(data?.racks || []).map((r) => (
              <option key={r._id} value={r._id}>
                {r.code}
              </option>
            ))}
          </select>
          <select value={filters.sync} onChange={(e) => setFilters({ ...filters, sync: e.target.value })}>
            <option value="">Sync on or off</option>
            <option value="on">Syncing to Shopify</option>
            <option value="off">Not syncing</option>
          </select>
          {data && (
            <span className="muted small" style={{ marginLeft: "auto" }}>
              {num(data.totals.onHand)} units · {money(data.totals.value)}
            </span>
          )}
        </div>
        {!data ? (
          <Spinner />
        ) : !data.rows.length ? (
          <div className="empty-row muted">No items here.</div>
        ) : (
          <table className="table table-click inv-table">
            <thead>
              <tr>
                <th style={{ width: 56 }} />
                <th>Item</th>
                <th>Category</th>
                <th className="num">In stock</th>
                <th>Racks</th>
                <th className="num">Blocked</th>
                <th className="num">Buffer</th>
                <th className="num">Virtual</th>
                <th className="num">Shopify</th>
                <th>Sync</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r._id} onClick={() => setView(r._id)} className={r.oversold ? "row-warn" : ""}>
                  <td data-label="">{r.image ? <img src={r.image} alt="" className="ship-thumb" loading="lazy" /> : <span className="ship-thumb empty" />}</td>
                  <td data-label="Item">
                    <strong>{r.sku || "—"}</strong>
                    <div>{r.name}</div>
                    <div className="muted small">
                      HSN {r.hsnSac || "—"} · {r.taxRate}%{r.links.length ? ` · ${r.links.length} linked` : ""}
                      {!r.active && " · inactive"}
                    </div>
                  </td>
                  <td data-label="Category">{r.category || <span className="muted">—</span>}</td>
                  <td data-label="In stock" className="num">
                    <strong className={r.onHand <= 0 && r.trackInventory ? "text-red" : ""}>{r.trackInventory ? num(r.onHand) : "—"}</strong>
                  </td>
                  <td data-label="Racks" className="small">
                    {r.racks.map((x) => `${x.code}:${num(x.qty)}`).join(" ")}
                    {r.unassigned.some((u) => u.qty) && <span className="muted"> {r.racks.length ? "+" : ""}{num(r.unassigned.reduce((s, u) => s + u.qty, 0))} unracked</span>}
                  </td>
                  <td data-label="Blocked" className="num">{num(r.blocked)}</td>
                  <td data-label="Buffer" className="num">{num(r.buffer)}</td>
                  <td data-label="Virtual" className="num">{num(r.virtual)}</td>
                  <td data-label="Shopify" className="num">
                    <strong>{r.shopify ?? "—"}</strong>
                  </td>
                  <td data-label="Sync" onClick={(e) => e.stopPropagation()}>
                    <label className="toggle" title={r.shopifyVariantId || r.links.length ? "Push this item's stock to Shopify" : "Not on Shopify — link a listing first"}>
                      <input type="checkbox" checked={r.shopifySync} disabled={!r.shopifyVariantId && !r.links.length} onChange={(e) => quickSync(r, e.target.checked)} />
                      <span />
                    </label>
                  </td>
                </tr>
              ))}
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
      {view && <ItemStock id={view} racks={data?.racks || []} onClose={() => setView(null)} onChanged={load} />}
      {showRacks && <RacksModal racks={data?.racks || []} warehouses={data?.warehouses || []} onClose={() => setShowRacks(false)} onChanged={load} />}
      {void Icon}
    </>
  );
}
