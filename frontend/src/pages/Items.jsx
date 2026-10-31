import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { GST_RATES, UNITS } from "../lib/constants";
import { money } from "../lib/format";
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
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i._id} onClick={() => navigate(`/items/${i._id}/edit`)}>
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
        const { type, name, sku, unit, hsnSac, rate, purchaseRate, taxRate, description, active } = data;
        setForm({ type, name, sku, unit, hsnSac, rate, purchaseRate, taxRate, description, active });
      });
    } else {
      setForm({ type: "goods", name: "", sku: "", unit: "pcs", hsnSac: "", rate: "", purchaseRate: "", taxRate: 18, description: "", active: true });
    }
  }, [id]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...form, rate: Number(form.rate || 0), purchaseRate: Number(form.purchaseRate || 0), taxRate: Number(form.taxRate) };
      if (id) await api.put(`/items/${id}`, body);
      else await api.post("/items", body);
      toast(id ? "Item updated" : "Item created");
      navigate("/items");
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
