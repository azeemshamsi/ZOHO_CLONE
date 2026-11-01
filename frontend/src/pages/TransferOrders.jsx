import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { date, isoDate } from "../lib/format";
import { useLocations } from "../lib/locations";
import { PageHeader, Spinner, Empty, Field, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

export function TransferList() {
  const [rows, setRows] = useState(null);
  const { warehouses } = useLocations();
  const navigate = useNavigate();
  const wn = (id) => warehouses.find((w) => w._id === id)?.name || "";
  useEffect(() => {
    api.get("/transfer-orders").then((r) => setRows(r.data));
  }, []);
  return (
    <>
      <PageHeader title="Transfer Orders">
        <Link to="/transfer-orders/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="box"
          title="No transfer orders yet"
          text={warehouses.length < 2 ? "Add two warehouses in Branches & Warehouses first, then move stock between them here." : "Move stock from one warehouse to another."}
          action={
            warehouses.length < 2 ? (
              <Link to="/locations" className="btn btn-primary">
                Set up warehouses
              </Link>
            ) : (
              <Link to="/transfer-orders/new" className="btn btn-primary">
                New Transfer Order
              </Link>
            )
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Date</th>
                <th>Transfer Order#</th>
                <th>From</th>
                <th>To</th>
                <th>Items</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t._id} onClick={() => navigate(`/transfer-orders/${t._id}`)}>
                  <td>{date(t.date)}</td>
                  <td className="link strong">{t.number}</td>
                  <td>{wn(t.from)}</td>
                  <td>{wn(t.to)}</td>
                  <td className="muted">{t.lines.map((l) => `${l.name} × ${l.quantity}`).join(", ")}</td>
                  <td>
                    <span className={`status status-${t.status === "transferred" ? "paid" : "draft"}`}>{t.status === "transferred" ? "Transferred" : "Draft"}</span>
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

export function TransferForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { warehouses } = useLocations();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.get("/items", { params: { inventory: "tracked", status: "active" } }).then((r) => setItems(r.data));
    if (id) api.get(`/transfer-orders/${id}`).then(({ data }) => setForm({ ...data, date: isoDate(data.date), lines: data.lines.map((l) => ({ item: l.item, quantity: l.quantity })) }));
    else setForm({ date: isoDate(), from: "", to: "", reason: "", lines: [{ item: "", quantity: "" }] });
  }, [id]);
  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setLine = (i, k, v) => setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const have = (it, w) => (it ? it.byWarehouse?.[w] ?? 0 : "");
  const save = async (status) => {
    setError("");
    try {
      const body = { date: form.date, from: form.from, to: form.to, reason: form.reason, status, lines: form.lines.filter((l) => l.item).map((l) => ({ item: l.item, quantity: Number(l.quantity) })) };
      const { data } = id ? await api.put(`/transfer-orders/${id}`, body) : await api.post("/transfer-orders", body);
      toast(status === "draft" ? "Saved as draft" : "Stock transferred");
      navigate(`/transfer-orders/${data._id}`);
    } catch (e) {
      setError(errMsg(e));
    }
  };
  const wsel = (k) => (
    <select value={form[k]} onChange={set(k)}>
      <option value="">Select a warehouse</option>
      {warehouses
        .filter((w) => w.active)
        .map((w) => (
          <option key={w._id} value={w._id}>
            {w.name}
          </option>
        ))}
    </select>
  );
  return (
    <>
      <PageHeader title={id ? `Edit ${form.number}` : "New Transfer Order"} back="/transfer-orders" />
      <div className="card form">
        <div className="form-grid">
          <div className="row-3">
            <Field label="Date" required>
              <input type="date" value={form.date} onChange={set("date")} />
            </Field>
            <Field label="Source Warehouse" required>
              {wsel("from")}
            </Field>
            <Field label="Destination Warehouse" required>
              {wsel("to")}
            </Field>
          </div>
          <Field label="Reason">
            <input value={form.reason} onChange={set("reason")} />
          </Field>
        </div>
        <table className="table adj-table">
          <thead>
            <tr>
              <th style={{ width: "45%" }}>Item</th>
              <th className="num">At Source</th>
              <th className="num">At Destination</th>
              <th className="num">Quantity to Transfer</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.lines.map((l, i) => {
              const it = items.find((x) => x._id === l.item);
              return (
                <tr key={i}>
                  <td>
                    <select value={l.item} onChange={(e) => setLine(i, "item", e.target.value)}>
                      <option value="">Select an item</option>
                      {items.map((x) => (
                        <option key={x._id} value={x._id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">{form.from && have(it, form.from)}</td>
                  <td className="num">{form.to && have(it, form.to)}</td>
                  <td>
                    <input type="number" step="any" min="0" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} />
                  </td>
                  <td>
                    {form.lines.length > 1 && (
                      <button type="button" className="icon-btn" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>
                        <Icon name="x" size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, lines: [...form.lines, { item: "", quantity: "" }] })}>
          <Icon name="plus" size={14} /> Add item
        </button>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" onClick={() => save("transferred")}>
            Initiate Transfer
          </button>
          <button className="btn" onClick={() => save("draft")}>
            Save as Draft
          </button>
        </div>
      </div>
    </>
  );
}

export function TransferView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { warehouses } = useLocations();
  const [t, setT] = useState(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    api.get(`/transfer-orders/${id}`).then((r) => setT(r.data));
  }, [id]);
  if (!t) return <Spinner />;
  const wn = (w) => warehouses.find((x) => x._id === w)?.name || "";
  return (
    <>
      <PageHeader title={t.number} subtitle={`${wn(t.from)} → ${wn(t.to)} · ${date(t.date)} · ${t.status === "transferred" ? "Transferred" : "Draft"}`} back="/transfer-orders">
        <Link to={`/transfer-orders/${id}/edit`} className="btn">
          Edit
        </Link>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Link to={`/items/${l.item}`}>{l.name}</Link>
                </td>
                <td className="num">{l.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.reason && <p className="muted" style={{ padding: "0 16px 14px" }}>{t.reason}</p>}
      </div>
      <Confirm
        open={confirm}
        title="Delete transfer order?"
        text="The stock moves back to the source warehouse."
        onConfirm={async () => {
          await api.delete(`/transfer-orders/${id}`);
          toast("Transfer order deleted");
          navigate("/transfer-orders");
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
