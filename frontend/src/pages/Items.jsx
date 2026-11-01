import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { GST_RATES, UNITS } from "../lib/constants";
import { money, date, isoDate } from "../lib/format";
import { docLink } from "./Accounts";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Confirm } from "../components/ui";
import Icon from "../components/Icon";

export function ItemList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/items", { params: { q: dq, status } }).then((r) => setRows(r.data));
  }, [dq, status]);

  return (
    <>
      <PageHeader title="Items">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active Items</option>
          <option value="inactive">Inactive Items</option>
          <option value="">All Items</option>
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Search items" />
        <Link to="/items/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="box"
          title={q ? "No items match your search" : "Add the goods and services you sell"}
          text="Save prices, HSN/SAC codes and GST rates once, then pick them on invoices."
          action={
            <Link to="/items/new" className="btn btn-primary">
              New Item
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>SKU</th>
                <th>HSN/SAC</th>
                <th>GST</th>
                <th className="num">Rate</th>
                <th className="num">Stock on Hand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i._id} onClick={() => navigate(`/items/${i._id}`)}>
                  <td className="strong link">
                    {i.name}
                    {i.description && <div className="muted small clamp">{i.description}</div>}
                  </td>
                  <td>{i.type === "goods" ? "Goods" : "Service"}</td>
                  <td>{i.sku}</td>
                  <td className="mono">{i.hsnSac}</td>
                  <td>{i.taxRate}%</td>
                  <td className="num">
                    {money(i.rate)}
                    {i.unit && <span className="muted small"> /{i.unit}</span>}
                  </td>
                  <td className="num">
                    {i.trackInventory ? (
                      <span className={i.stockOnHand <= (i.reorderLevel || 0) ? "text-danger strong" : ""} title={i.stockOnHand <= (i.reorderLevel || 0) ? "At or below reorder level" : ""}>
                        {i.stockOnHand} {i.unit}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
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

export function ItemForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (id) {
      api.get(`/items/${id}`).then(({ data }) => {
        const { type, name, sku, unit, hsnSac, rate, purchaseRate, taxRate, description, active, trackInventory, openingStock, openingStockRate, openingStockDate, reorderLevel } = data;
        setForm({ type, name, sku, unit, hsnSac, rate, purchaseRate, taxRate, description, active, trackInventory: !!trackInventory, openingStock: openingStock || "", openingStockRate: openingStockRate || "", openingStockDate: openingStockDate ? openingStockDate.slice(0, 10) : "", reorderLevel: reorderLevel || "" });
      });
    } else {
      setForm({ type: "goods", name: "", sku: "", unit: "pcs", hsnSac: "", rate: "", purchaseRate: "", taxRate: 18, description: "", active: true, trackInventory: true, openingStock: "", openingStockRate: "", openingStockDate: isoDate(), reorderLevel: "" });
    }
  }, [id]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        ...form,
        rate: Number(form.rate || 0),
        purchaseRate: Number(form.purchaseRate || 0),
        taxRate: Number(form.taxRate),
        openingStock: Number(form.openingStock || 0),
        openingStockRate: Number(form.openingStockRate || 0),
        reorderLevel: Number(form.reorderLevel || 0),
      };
      if (id) await api.put(`/items/${id}`, body);
      else await api.post("/items", body);
      toast(id ? "Item updated" : "Item created");
      navigate(id ? `/items/${id}` : "/items");
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/items/${id}`);
      toast("Item deleted");
      navigate("/items");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={id ? "Edit Item" : "New Item"} back="/items">
        {id && (
          <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
            <Icon name="trash" />
          </button>
        )}
      </PageHeader>
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Type">
            <div className="radio-row">
              {["goods", "service"].map((t) => (
                <label key={t} className="radio">
                  <input type="radio" checked={form.type === t} onChange={() => setForm({ ...form, type: t })} />
                  {t === "goods" ? "Goods" : "Service"}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Name" required>
            <input required autoFocus value={form.name} onChange={set("name")} />
          </Field>
          <div className="row-2">
            <Field label="SKU">
              <input value={form.sku} onChange={set("sku")} />
            </Field>
            <Field label="Unit">
              <input list="units" value={form.unit} onChange={set("unit")} />
              <datalist id="units">
                {UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </Field>
          </div>
          <div className="row-2">
            <Field label={form.type === "goods" ? "HSN Code" : "SAC Code"}>
              <input value={form.hsnSac} onChange={set("hsnSac")} className="mono" />
            </Field>
            <Field label="GST Rate" required>
              <select value={form.taxRate} onChange={set("taxRate")}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    GST {r}%
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <h4 className="section-title">Sales & Purchase</h4>
        <div className="form-grid">
          <div className="row-2">
            <Field label="Selling Price (₹)" required hint="Excluding GST">
              <input type="number" step="0.01" min="0" required value={form.rate} onChange={set("rate")} />
            </Field>
            <Field label="Cost Price (₹)">
              <input type="number" step="0.01" min="0" value={form.purchaseRate} onChange={set("purchaseRate")} />
            </Field>
          </div>
          <Field label="Description" hint="Shown on invoices under the item name">
            <textarea rows={3} value={form.description} onChange={set("description")} />
          </Field>
          {id && (
            <label className="check">
              <input type="checkbox" checked={form.active} onChange={set("active")} /> Active
            </label>
          )}
        </div>
        {form.type === "goods" && (
          <>
            <h4 className="section-title">Inventory</h4>
            <div className="form-grid">
              <label className="check">
                <input type="checkbox" checked={form.trackInventory} onChange={set("trackInventory")} /> Track inventory for this item
              </label>
              {form.trackInventory && (
                <>
                  <p className="muted small">Bills add stock, invoices remove it, and its cost (FIFO) moves to Cost of Goods Sold when it's sold.</p>
                  <div className="row-2">
                    <Field label="Opening Stock" hint={form.unit ? `in ${form.unit}` : ""}>
                      <input type="number" step="any" min="0" value={form.openingStock} onChange={set("openingStock")} />
                    </Field>
                    <Field label="Opening Stock Rate per Unit (₹)">
                      <input type="number" step="0.01" min="0" value={form.openingStockRate} onChange={set("openingStockRate")} />
                    </Field>
                  </div>
                  <div className="row-2">
                    <Field label="Opening Stock As Of">
                      <input type="date" value={form.openingStockDate} onChange={set("openingStockDate")} />
                    </Field>
                    <Field label="Reorder Level" hint="Flagged when stock falls to this level">
                      <input type="number" step="any" min="0" value={form.reorderLevel} onChange={set("reorderLevel")} />
                    </Field>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => navigate("/items")}>
            Cancel
          </button>
        </div>
      </form>
      <Confirm open={confirm} title="Delete item?" text="This can't be undone." onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}

export function ItemDetail() {
  const { id } = useParams();
  const [item, setItem] = useState(null);
  const [stock, setStock] = useState(null);
  useEffect(() => {
    api.get(`/items/${id}`).then((r) => setItem(r.data));
    api.get(`/items/${id}/stock`).then((r) => setStock(r.data));
  }, [id]);
  if (!item) return <Spinner />;
  const low = item.trackInventory && item.stockOnHand <= (item.reorderLevel || 0);
  const stat = (label, value, cls = "") => (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className={`stat-value ${cls}`}>{value}</div>
    </div>
  );
  return (
    <>
      <PageHeader title={item.name} subtitle={[item.type === "goods" ? "Goods" : "Service", item.sku && `SKU ${item.sku}`, item.hsnSac && `HSN/SAC ${item.hsnSac}`].filter(Boolean).join(" · ")} back="/items">
        {item.trackInventory && (
          <Link to={`/inventory-adjustments/new?item=${item._id}`} className="btn">
            Adjust Stock
          </Link>
        )}
        <Link to={`/items/${id}/edit`} className="btn btn-primary">
          Edit
        </Link>
      </PageHeader>
      <div className="card">
        <div className="stats-row">
          {stat("Selling Price", money(item.rate))}
          {stat("Cost Price", money(item.purchaseRate))}
          {stat("GST", `${item.taxRate}%`)}
          {item.trackInventory && (
            <>
              {stat("Stock on Hand", `${item.stockOnHand} ${item.unit}`, low ? "text-danger" : "")}
              {stat("Committed", `${item.committed} ${item.unit}`)}
              {stat("Available for Sale", `${item.available} ${item.unit}`)}
              {stat("Stock Value", money(item.stockValue))}
              {stat("Reorder Level", `${item.reorderLevel || 0} ${item.unit}`)}
            </>
          )}
        </div>
        {low && <div className="alert alert-warn">Stock is at or below the reorder level.</div>}
      </div>
      {item.trackInventory &&
        (!stock ? (
          <Spinner />
        ) : (
          <div className="card flush">
            <h3 className="card-title pad">Stock Movements</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transaction</th>
                  <th>Number</th>
                  <th>Party / Reason</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Cost / Unit</th>
                  <th className="num">Value</th>
                  <th className="num">Stock</th>
                  <th className="num">Stock Value</th>
                </tr>
              </thead>
              <tbody>
                {stock.moves.map((m, i) => (
                  <tr key={i}>
                    <td>{date(m.date)}</td>
                    <td>{m.type}</td>
                    <td>{m.type === "Opening Stock" ? "" : <Link to={m.type === "Inventory Adjustment" ? `/inventory-adjustments/${m.id}` : docLink(m.type, m.id)}>{m.number}</Link>}</td>
                    <td>{m.party}</td>
                    <td className="num">{m.qtyIn || ""}</td>
                    <td className="num">{m.qtyOut || ""}</td>
                    <td className="num">{m.unitCost ? money(m.unitCost) : ""}</td>
                    <td className="num">{money(m.value)}</td>
                    <td className={`num ${m.qty < 0 ? "text-danger" : ""}`}>{m.qty}</td>
                    <td className="num">{money(m.stockValue)}</td>
                  </tr>
                ))}
                {!stock.moves.length && (
                  <tr>
                    <td colSpan={10} className="muted center">
                      No stock movements yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
