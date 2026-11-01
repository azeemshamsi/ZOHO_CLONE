import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date, isoDate } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, toast, Confirm } from "../components/ui";
import Icon from "../components/Icon";

const accountName = (accounts, code) => (accounts.find((a) => a.code === code) || { name: code }).name;

export function AdjustmentList() {
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.get("/inventory-adjustments").then((r) => setRows(r.data));
  }, []);
  return (
    <>
      <PageHeader title="Inventory Adjustments">
        <Link to="/inventory-adjustments/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="box"
          title="No inventory adjustments yet"
          text="Record stocktake differences, damaged or stolen goods, or revalue your stock."
          action={
            <Link to="/inventory-adjustments/new" className="btn btn-primary">
              New Adjustment
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Date</th>
                <th>Number</th>
                <th>Reference</th>
                <th>Reason</th>
                <th>Type</th>
                <th>Status</th>
                <th>Items</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a._id} onClick={() => navigate(`/inventory-adjustments/${a._id}`)}>
                  <td>{date(a.date)}</td>
                  <td className="strong link">{a.number}</td>
                  <td>{a.reference}</td>
                  <td>{a.reason}</td>
                  <td>{a.mode === "value" ? "Value" : "Quantity"}</td>
                  <td>
                    <span className={`status status-${a.status === "adjusted" ? "paid" : "draft"}`}>{a.status === "adjusted" ? "Adjusted" : "Draft"}</span>
                  </td>
                  <td className="muted">{a.lines.map((l) => l.name).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AdjustmentForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.get("/items", { params: { inventory: "tracked", status: "active" } }), api.get("/inventory-adjustments/reasons"), api.get("/accounts")]).then(async ([i, r, a]) => {
      setItems(i.data);
      setReasons(r.data);
      setAccounts(a.data.filter((x) => ["expense", "income", "equity"].includes(x.type) || x.code === "cogs"));
      if (id) {
        const { data } = await api.get(`/inventory-adjustments/${id}`);
        setForm({ ...data, date: data.date.slice(0, 10), lines: data.lines.map((l) => ({ ...l, item: String(l.item), quantityAdjusted: l.quantityAdjusted || "", costPrice: l.costPrice || "", valueAdjusted: l.valueAdjusted || "" })) });
      } else {
        const pre = params.get("item");
        setForm({ mode: "quantity", date: isoDate(), reference: "", reason: r.data[0], account: "cogs", description: "", lines: [{ item: pre || "", quantityAdjusted: "", costPrice: "", valueAdjusted: "" }] });
      }
    });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form || !items) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setLine = (i, k, v) => setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const itemOf = (iid) => items.find((x) => x._id === iid);

  const save = async (status) => {
    setBusy(true);
    setError("");
    try {
      const body = {
        mode: form.mode,
        date: form.date,
        reference: form.reference,
        reason: form.reason,
        account: form.account,
        description: form.description,
        status,
        lines: form.lines
          .filter((l) => l.item)
          .map((l) => ({ item: l.item, quantityAdjusted: Number(l.quantityAdjusted || 0), costPrice: Number(l.costPrice || 0), valueAdjusted: Number(l.valueAdjusted || 0) })),
      };
      const { data } = id ? await api.put(`/inventory-adjustments/${id}`, body) : await api.post("/inventory-adjustments", body);
      toast(status === "draft" ? "Saved as draft" : "Stock adjusted");
      navigate(`/inventory-adjustments/${data._id}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? `Edit ${form.number}` : "New Adjustment"} back="/inventory-adjustments" />
      <div className="card form">
        {!items.length && (
          <div className="alert alert-warn">
            No items track inventory yet. Turn on "Track inventory" on an item first.
          </div>
        )}
        <div className="form-grid">
          <Field label="Mode of Adjustment">
            <div className="radio-row">
              {[
                ["quantity", "Quantity Adjustment"],
                ["value", "Value Adjustment"],
              ].map(([k, l]) => (
                <label key={k} className="radio">
                  <input type="radio" checked={form.mode === k} onChange={() => setForm({ ...form, mode: k })} />
                  {l}
                </label>
              ))}
            </div>
          </Field>
          <div className="row-2">
            <Field label="Date" required>
              <input type="date" value={form.date} onChange={set("date")} />
            </Field>
            <Field label="Reference#">
              <input value={form.reference} onChange={set("reference")} />
            </Field>
          </div>
          <div className="row-2">
            <Field label="Reason" required>
              <select value={form.reason} onChange={set("reason")}>
                {reasons.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Account" hint="Where the gain or loss is recorded">
              <select value={form.account} onChange={set("account")}>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={2} value={form.description} onChange={set("description")} />
          </Field>
        </div>
        <table className="table adj-table">
          <thead>
            <tr>
              <th style={{ width: "34%" }}>Item</th>
              <th className="num">Stock on Hand</th>
              {form.mode === "quantity" ? (
                <>
                  <th className="num">New Quantity</th>
                  <th className="num">Quantity Adjusted</th>
                  <th className="num">Cost per Unit (stock added)</th>
                </>
              ) : (
                <>
                  <th className="num">Current Value</th>
                  <th className="num">Value Adjusted</th>
                </>
              )}
              <th />
            </tr>
          </thead>
          <tbody>
            {form.lines.map((l, i) => {
              const it = itemOf(l.item);
              const onHand = it ? it.stockOnHand : 0;
              return (
                <tr key={i}>
                  <td>
                    <select value={l.item} onChange={(e) => setLine(i, "item", e.target.value)}>
                      <option value="">Select an item</option>
                      {items.map((x) => (
                        <option key={x._id} value={x._id}>
                          {x.name}
                          {x.sku ? ` (${x.sku})` : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">{it ? `${onHand} ${it.unit}` : ""}</td>
                  {form.mode === "quantity" ? (
                    <>
                      <td>
                        <input
                          type="number"
                          step="any"
                          disabled={!it}
                          value={l.quantityAdjusted === "" ? "" : Math.round((onHand + Number(l.quantityAdjusted)) * 100) / 100}
                          onChange={(e) => setLine(i, "quantityAdjusted", e.target.value === "" ? "" : Math.round((Number(e.target.value) - onHand) * 100) / 100)}
                        />
                      </td>
                      <td>
                        <input type="number" step="any" disabled={!it} value={l.quantityAdjusted} onChange={(e) => setLine(i, "quantityAdjusted", e.target.value)} placeholder="e.g. -2 or 5" />
                      </td>
                      <td>
                        <input type="number" step="0.01" min="0" disabled={!it || !(Number(l.quantityAdjusted) > 0)} value={l.costPrice} onChange={(e) => setLine(i, "costPrice", e.target.value)} placeholder={it ? `avg ${money(it.avgCost)}` : ""} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="num">{it ? money(it.stockValue) : ""}</td>
                      <td>
                        <input type="number" step="0.01" disabled={!it} value={l.valueAdjusted} onChange={(e) => setLine(i, "valueAdjusted", e.target.value)} placeholder="e.g. -500" />
                      </td>
                    </>
                  )}
                  <td>
                    {form.lines.length > 1 && (
                      <button className="icon-btn" title="Remove" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>
                        <Icon name="trash" size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, lines: [...form.lines, { item: "", quantityAdjusted: "", costPrice: "", valueAdjusted: "" }] })}>
          <Icon name="plus" size={14} /> Add another item
        </button>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy} onClick={() => save("adjusted")}>
            Convert to Adjusted
          </button>
          <button className="btn" disabled={busy} onClick={() => save("draft")}>
            Save as Draft
          </button>
          <button className="btn" onClick={() => navigate("/inventory-adjustments")}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

export function AdjustmentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [a, setA] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    api.get(`/inventory-adjustments/${id}`).then((r) => setA(r.data));
    api.get("/accounts").then((r) => setAccounts(r.data));
  }, [id]);
  if (!a) return <Spinner />;
  const remove = async () => {
    await api.delete(`/inventory-adjustments/${id}`);
    toast("Adjustment deleted");
    navigate("/inventory-adjustments");
  };
  return (
    <>
      <PageHeader title={a.number} subtitle={`${a.mode === "value" ? "Value" : "Quantity"} adjustment · ${a.status === "adjusted" ? "Adjusted" : "Draft"}`} back="/inventory-adjustments">
        <Link to={`/inventory-adjustments/${id}/edit`} className="btn">
          Edit
        </Link>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card">
        <div className="stats-row">
          <div className="stat">
            <div className="muted small">Date</div>
            <div className="stat-value">{date(a.date)}</div>
          </div>
          <div className="stat">
            <div className="muted small">Reason</div>
            <div className="stat-value">{a.reason}</div>
          </div>
          <div className="stat">
            <div className="muted small">Account</div>
            <div className="stat-value">{accountName(accounts, a.account)}</div>
          </div>
          {a.reference && (
            <div className="stat">
              <div className="muted small">Reference</div>
              <div className="stat-value">{a.reference}</div>
            </div>
          )}
          <div className="stat">
            <div className="muted small">Change in stock value</div>
            <div className="stat-value">{a.status === "adjusted" ? money(a.valueChange) : "—"}</div>
          </div>
        </div>
        {a.description && <p className="muted">{a.description}</p>}
      </div>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">{a.mode === "value" ? "Value Adjusted" : "Quantity Adjusted"}</th>
              {a.mode === "quantity" && <th className="num">Cost per Unit</th>}
            </tr>
          </thead>
          <tbody>
            {a.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Link to={`/items/${l.item}`}>{l.name}</Link>
                </td>
                <td className="num">{a.mode === "value" ? money(l.valueAdjusted) : l.quantityAdjusted > 0 ? `+${l.quantityAdjusted}` : l.quantityAdjusted}</td>
                {a.mode === "quantity" && <td className="num">{l.quantityAdjusted > 0 ? (l.costPrice ? money(l.costPrice) : "Average cost") : "FIFO"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Confirm open={confirm} title="Delete adjustment?" text="Stock and the books will be recalculated without it." onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}
