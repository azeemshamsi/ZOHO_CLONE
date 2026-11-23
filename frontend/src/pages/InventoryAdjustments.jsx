import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date, isoDate } from "../lib/format";
import {
  PageHeader,
  Spinner,
  Empty,
  Field,
  toast,
  Confirm,
} from "../components/ui";
import Icon from "../components/Icon";
import { useLocations } from "../lib/locations";
import SearchSelect, {
  partyOptions,
  itemOptions,
} from "../components/SearchSelect";

const accountName = (accounts, code) =>
  (accounts.find((a) => a.code === code) || { name: code }).name;

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
                <tr
                  key={a._id}
                  onClick={() => navigate(`/inventory-adjustments/${a._id}`)}
                >
                  <td>{date(a.date)}</td>
                  <td className="strong link">{a.number}</td>
                  <td>{a.reference}</td>
                  <td>{a.reason}</td>
                  <td>{a.mode === "value" ? "Value" : "Quantity"}</td>
                  <td>
                    <span
                      className={`status status-${a.status === "adjusted" ? "paid" : "draft"}`}
                    >
                      {a.status === "adjusted" ? "Adjusted" : "Draft"}
                    </span>
                  </td>
                  <td className="muted">
                    {a.lines.map((l) => l.name).join(", ")}
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

export function AdjustmentForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { warehouses } = useLocations();

  useEffect(() => {
    Promise.all([
      api.get("/items", { params: { inventory: "tracked", status: "active" } }),
      api.get("/inventory-adjustments/reasons"),
      api.get("/accounts"),
    ]).then(async ([i, r, a]) => {
      setItems(i.data);
      setReasons(r.data);
      setAccounts(
        a.data.filter(
          (x) =>
            ["expense", "income", "equity"].includes(x.type) ||
            x.code === "cogs",
        ),
      );
      setAllAccounts(a.data);
      if (id) {
        const { data } = await api.get(`/inventory-adjustments/${id}`);
        setForm({
          ...data,
          warehouse: data.warehouse || "",
          date: data.date.slice(0, 10),
          lines: data.lines.map((l) => ({
            ...l,
            item: String(l.item),
            quantityAdjusted: l.quantityAdjusted || "",
            costPrice: l.costPrice || "",
            valueAdjusted: l.valueAdjusted || "",
            rate: l.rate ?? "",
            costPercent: l.costPercent ?? "",
          })),
          additionalCosts: data.additionalCosts || [],
        });
      } else {
        const pre = params.get("item");
        setForm({
          mode: "quantity",
          date: isoDate(),
          reference: "",
          reason: r.data[0],
          account: "cogs",
          description: "",
          lines: [
            {
              item: pre || "",
              quantityAdjusted: "",
              costPrice: "",
              valueAdjusted: "",
            },
          ],
        });
      }
    });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form || !items) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setLine = (i, k, v) =>
    setForm({
      ...form,
      lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)),
    });
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
        warehouse: form.warehouse || null,
        status,
        lines: form.lines
          .filter((l) => l.item)
          .map((l) => ({
            item: l.item,
            quantityAdjusted: Number(l.quantityAdjusted || 0),
            costPrice: Number(l.costPrice || 0),
            valueAdjusted: Number(l.valueAdjusted || 0),
            ...(Number(l.rate) > 0 ? { rate: Number(l.rate) } : {}),
            ...(l.costPercent !== "" && l.costPercent != null
              ? { costPercent: Number(l.costPercent) }
              : {}),
          })),
        additionalCosts:
          form.reason === "Manufacturing"
            ? (form.additionalCosts || [])
                .filter(
                  (c) => c.account || Number(c.amount) || Number(c.percent),
                )
                .map((c) => ({
                  account: c.account || "",
                  name: c.name || "",
                  percent: Number(c.percent) || 0,
                  amount: Number(c.amount) || 0,
                }))
            : [],
      };
      const { data } = id
        ? await api.put(`/inventory-adjustments/${id}`, body)
        : await api.post("/inventory-adjustments", body);
      toast(status === "draft" ? "Saved as draft" : "Stock adjusted");
      navigate(`/inventory-adjustments/${data._id}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={id ? `Edit ${form.number}` : "New Adjustment"}
        back="/inventory-adjustments"
      />
      <div className="card form">
        {!items.length && (
          <div className="alert alert-warn">
            No items track inventory yet. Turn on "Track inventory" on an item
            first.
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
                  <input
                    type="radio"
                    checked={form.mode === k}
                    onChange={() => setForm({ ...form, mode: k })}
                  />
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
          {warehouses.length > 1 && (
            <Field label="Warehouse">
              <select value={form.warehouse || ""} onChange={set("warehouse")}>
                <option value="">
                  {warehouses.find((w) => w.primary)?.name} (primary)
                </option>
                {warehouses
                  .filter((w) => !w.primary)
                  .map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="Description">
            <textarea
              rows={2}
              value={form.description}
              onChange={set("description")}
            />
          </Field>
        </div>
        {form.mode === "quantity" && form.reason === "Manufacturing" ? (
          <Manufacture
            form={form}
            setForm={setForm}
            items={items}
            accounts={allAccounts}
          />
        ) : (
          <>
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
                        <SearchSelect
                          value={l.item}
                          options={itemOptions(items)}
                          onChange={(v) => setLine(i, "item", v)}
                          placeholder="Search items by name, SKU or HSN…"
                        />
                      </td>
                      <td className="num">
                        {it ? `${onHand} ${it.unit}` : ""}
                      </td>
                      {form.mode === "quantity" ? (
                        <>
                          <td>
                            <input
                              type="number"
                              step="any"
                              disabled={!it}
                              value={
                                l.quantityAdjusted === ""
                                  ? ""
                                  : Math.round(
                                      (onHand + Number(l.quantityAdjusted)) *
                                        100,
                                    ) / 100
                              }
                              onChange={(e) =>
                                setLine(
                                  i,
                                  "quantityAdjusted",
                                  e.target.value === ""
                                    ? ""
                                    : Math.round(
                                        (Number(e.target.value) - onHand) * 100,
                                      ) / 100,
                                )
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="any"
                              disabled={!it}
                              value={l.quantityAdjusted}
                              onChange={(e) =>
                                setLine(i, "quantityAdjusted", e.target.value)
                              }
                              placeholder="e.g. -2 or 5"
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              disabled={
                                !it || !(Number(l.quantityAdjusted) > 0)
                              }
                              value={l.costPrice}
                              onChange={(e) =>
                                setLine(i, "costPrice", e.target.value)
                              }
                              placeholder={it ? `avg ${money(it.avgCost)}` : ""}
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="num">
                            {it ? money(it.stockValue) : ""}
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              disabled={!it}
                              value={l.valueAdjusted}
                              onChange={(e) =>
                                setLine(i, "valueAdjusted", e.target.value)
                              }
                              placeholder="e.g. -500"
                            />
                          </td>
                        </>
                      )}
                      <td>
                        {form.lines.length > 1 && (
                          <button
                            className="icon-btn"
                            title="Remove"
                            onClick={() =>
                              setForm({
                                ...form,
                                lines: form.lines.filter((_, j) => j !== i),
                              })
                            }
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button
              type="button"
              className="link-btn add-row"
              onClick={() =>
                setForm({
                  ...form,
                  lines: [
                    ...form.lines,
                    {
                      item: "",
                      quantityAdjusted: "",
                      costPrice: "",
                      valueAdjusted: "",
                    },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> Add another item
            </button>
          </>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => save("adjusted")}
          >
            Convert to Adjusted
          </button>
          <button className="btn" disabled={busy} onClick={() => save("draft")}>
            Save as Draft
          </button>
          <button
            className="btn"
            onClick={() => navigate("/inventory-adjustments")}
          >
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
      <PageHeader
        title={a.number}
        subtitle={`${a.mode === "value" ? "Value" : "Quantity"} adjustment · ${a.status === "adjusted" ? "Adjusted" : "Draft"}`}
        back="/inventory-adjustments"
      >
        <Link to={`/inventory-adjustments/${id}/edit`} className="btn">
          Edit
        </Link>
        <button
          className="icon-btn"
          title="Delete"
          onClick={() => setConfirm(true)}
        >
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
            <div className="stat-value">
              {a.status === "adjusted" ? money(a.valueChange) : "—"}
            </div>
          </div>
        </div>
        {a.description && <p className="muted">{a.description}</p>}
      </div>
      {a.reason === "Manufacturing" &&
      a.lines.some((l) => l.quantityAdjusted < 0 && l.rate) ? (
        <MfgView a={a} accounts={accounts} />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">
                  {a.mode === "value" ? "Value Adjusted" : "Quantity Adjusted"}
                </th>
                {a.mode === "quantity" && (
                  <th className="num">Cost per Unit</th>
                )}
              </tr>
            </thead>
            <tbody>
              {a.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <Link to={`/items/${l.item}`}>{l.name}</Link>
                  </td>
                  <td className="num">
                    {a.mode === "value"
                      ? money(l.valueAdjusted)
                      : l.quantityAdjusted > 0
                        ? `+${l.quantityAdjusted}`
                        : l.quantityAdjusted}
                  </td>
                  {a.mode === "quantity" && (
                    <td className="num">
                      {l.quantityAdjusted > 0
                        ? l.costPrice
                          ? money(l.costPrice)
                          : "Average cost"
                        : "FIFO"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Confirm
        open={confirm}
        title="Delete adjustment?"
        text="Stock and the books will be recalculated without it."
        onConfirm={remove}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

/* ======================= Manufacturing (like Tally's Manufacturing Journal) ======================= */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sideOf = (l) =>
  l.side || (Number(l.quantityAdjusted) < 0 ? "used" : "made");
// Components at their rates + additional costs = effective cost, shared to what's made by % of cost.
export function mfgCosts(lines, additionalCosts = []) {
  const used = lines.filter((l) => sideOf(l) === "used");
  const made = lines.filter((l) => sideOf(l) === "made");
  const components = r2(
    used.reduce(
      (t, l) =>
        t + Math.abs(Number(l.quantityAdjusted) || 0) * (Number(l.rate) || 0),
      0,
    ),
  );
  const costs = additionalCosts.map((c) => ({
    ...c,
    value:
      Number(c.percent) > 0 && !(Number(c.amount) > 0)
        ? r2((components * Number(c.percent)) / 100)
        : r2(c.amount),
  }));
  const addl = r2(costs.reduce((t, c) => t + c.value, 0));
  const effective = r2(components + addl);
  const fixed = made.filter((l) => Number(l.costPercent) > 0);
  const left = Math.max(
    0,
    100 - fixed.reduce((t, l) => t + Number(l.costPercent), 0),
  );
  const rest = made.filter((l) => !(Number(l.costPercent) > 0));
  const restQty = rest.reduce(
    (t, l) => t + (Number(l.quantityAdjusted) || 0),
    0,
  );
  const pctOf = (l) =>
    Number(l.costPercent) > 0
      ? Number(l.costPercent)
      : restQty
        ? (left * (Number(l.quantityAdjusted) || 0)) / restQty
        : 0;
  const share = (l) => r2((effective * pctOf(l)) / 100);
  const rateOf = (l) =>
    Number(l.quantityAdjusted) > 0
      ? r2(share(l) / Number(l.quantityAdjusted))
      : 0;
  return { components, costs, addl, effective, pctOf, share, rateOf };
}

function Manufacture({ form, setForm, items, accounts }) {
  const lines = form.lines;
  const costs = form.additionalCosts || [];
  const m = mfgCosts(lines, costs);
  const itemOf = (iid) => items.find((x) => x._id === iid);
  const setL = (i, patch) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));
  const addL = (side) =>
    setForm((f) => ({
      ...f,
      lines: [
        ...f.lines,
        {
          item: "",
          side,
          quantityAdjusted: "",
          rate: "",
          costPrice: "",
          costPercent: "",
          valueAdjusted: "",
        },
      ],
    }));
  const delL = (i) =>
    setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }));
  const setC = (i, patch) =>
    setForm((f) => ({
      ...f,
      additionalCosts: (f.additionalCosts || []).map((c, j) =>
        j === i ? { ...c, ...patch } : c,
      ),
    }));
  // Keep each made item's cost per unit in step (the server works it out the same way).
  useEffect(() => {
    const next = form.lines.map((l) =>
      sideOf(l) === "made" && Number(l.quantityAdjusted) > 0 && m.components > 0
        ? { ...l, costPrice: m.rateOf(l) }
        : l,
    );
    if (next.some((l, i) => l.costPrice !== form.lines[i].costPrice))
      setForm((f) => ({ ...f, lines: next }));
  }, [
    JSON.stringify(
      form.lines.map((l) => [
        l.item,
        l.quantityAdjusted,
        l.rate,
        l.costPercent,
      ]),
    ),
    JSON.stringify(costs),
  ]); // eslint-disable-line react-hooks/exhaustive-deps
  const qty = (l) => Math.abs(Number(l.quantityAdjusted) || 0) || "";
  const setQty = (i, l, v) =>
    setL(i, {
      quantityAdjusted:
        v === ""
          ? ""
          : sideOf(l) === "used"
            ? -Math.abs(Number(v))
            : Math.abs(Number(v)),
      side: sideOf(l),
    });
  const expense = accounts.filter(
    (a) =>
      ["expense", "cogs"].includes(a.type) ||
      ["Expense", "Cost Of Goods Sold", "Other Expense"].includes(a.group),
  );
  const row = (l, i, used) => {
    const it = itemOf(l.item);
    return (
      <tr key={i}>
        <td style={{ minWidth: 220 }}>
          <SearchSelect
            value={l.item}
            options={itemOptions(items)}
            onChange={(v) => setL(i, { item: v, side: sideOf(l) })}
            placeholder="Item…"
          />
          {it && (
            <div className="muted small">
              In stock {it.stockOnHand} {it.unit}
            </div>
          )}
        </td>
        {!used && (
          <td style={{ width: 90 }}>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={l.costPercent ?? ""}
              onChange={(e) => setL(i, { costPercent: e.target.value })}
              placeholder={`${r2(m.pctOf(l))}`}
              title="% of cost allocation (blank = the rest)"
            />
          </td>
        )}
        <td style={{ width: 100 }}>
          <input
            type="number"
            min="0"
            step="any"
            value={qty(l)}
            onChange={(e) => setQty(i, l, e.target.value)}
          />
        </td>
        <td style={{ width: 120 }}>
          {used ? (
            <input
              type="number"
              min="0"
              step="0.01"
              value={l.rate ?? ""}
              onChange={(e) => setL(i, { rate: e.target.value })}
              placeholder={it ? `avg ${r2(it.avgCost)}` : ""}
            />
          ) : (
            <span className="num">
              {m.components > 0 ? (
                money(m.rateOf(l))
              ) : (
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={l.costPrice}
                  onChange={(e) => setL(i, { costPrice: e.target.value })}
                />
              )}
            </span>
          )}
        </td>
        <td className="num">
          {money(
            used
              ? Math.abs(Number(l.quantityAdjusted) || 0) *
                  (Number(l.rate) || 0)
              : m.components > 0
                ? m.share(l)
                : (Number(l.quantityAdjusted) || 0) *
                  (Number(l.costPrice) || 0),
          )}
        </td>
        <td>
          <button className="icon-btn" title="Remove" onClick={() => delL(i)}>
            <Icon name="trash" size={16} />
          </button>
        </td>
      </tr>
    );
  };
  const made = lines
    .map((l, i) => [l, i])
    .filter(([l]) => sideOf(l) === "made");
  const used = lines
    .map((l, i) => [l, i])
    .filter(([l]) => sideOf(l) === "used");
  return (
    <div className="mfg">
      <h4 className="section-title">
        Made (product, co-product, by-product, scrap)
      </h4>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>% of cost</th>
            <th>Quantity</th>
            <th>Rate</th>
            <th className="num">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>{made.map(([l, i]) => row(l, i, false))}</tbody>
      </table>
      <button
        type="button"
        className="link-btn add-row"
        onClick={() => addL("made")}
      >
        <Icon name="plus" size={14} /> Add item made
      </button>
      <h4 className="section-title">Components (consumption)</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Quantity</th>
            <th>Rate</th>
            <th className="num">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>{used.map(([l, i]) => row(l, i, true))}</tbody>
      </table>
      <button
        type="button"
        className="link-btn add-row"
        onClick={() => addL("used")}
      >
        <Icon name="plus" size={14} /> Add component
      </button>
      <h4 className="section-title">Additional costs (labour, freight…)</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Ledger</th>
            <th>% of components</th>
            <th className="num">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {costs.map((c, i) => (
            <tr key={i}>
              <td>
                <select
                  value={c.account || ""}
                  onChange={(e) =>
                    setC(i, {
                      account: e.target.value,
                      name:
                        accounts.find((a) => a.code === e.target.value)?.name ||
                        "",
                    })
                  }
                >
                  <option value="">{c.name || "Choose a ledger…"}</option>
                  {expense.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ width: 120 }}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={c.percent || ""}
                  onChange={(e) =>
                    setC(i, { percent: e.target.value, amount: "" })
                  }
                  placeholder="%"
                />
              </td>
              <td style={{ width: 140 }}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={
                    Number(c.percent) > 0 && !(Number(c.amount) > 0)
                      ? m.costs[i]?.value
                      : c.amount || ""
                  }
                  onChange={(e) =>
                    setC(i, { amount: e.target.value, percent: "" })
                  }
                />
              </td>
              <td>
                <button
                  className="icon-btn"
                  title="Remove"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      additionalCosts: (f.additionalCosts || []).filter(
                        (_, j) => j !== i,
                      ),
                    }))
                  }
                >
                  <Icon name="trash" size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="link-btn add-row"
        onClick={() =>
          setForm((f) => ({
            ...f,
            additionalCosts: [
              ...(f.additionalCosts || []),
              { account: "", name: "", percent: "", amount: "" },
            ],
          }))
        }
      >
        <Icon name="plus" size={14} /> Add additional cost
      </button>
      <MfgSummary
        m={m}
        made={made.map(([l]) => ({
          ...l,
          name: itemOf(l.item)?.name || l.name,
        }))}
      />
    </div>
  );
}

function MfgSummary({ m, made }) {
  return (
    <table
      className="table"
      style={{ maxWidth: 520, marginLeft: "auto", marginTop: 12 }}
    >
      <tbody>
        <tr>
          <td>Cost of components</td>
          <td className="num">{money(m.components)}</td>
        </tr>
        <tr>
          <td>Total additional cost</td>
          <td className="num">{money(m.addl)}</td>
        </tr>
        <tr className="strong">
          <td>Effective cost</td>
          <td className="num">{money(m.effective)}</td>
        </tr>
        {made.map((l, i) => (
          <tr key={i}>
            <td>
              {l.name || "Item"} · {r2(m.pctOf(l))}% ·{" "}
              {Math.abs(Number(l.quantityAdjusted) || 0)} × {money(m.rateOf(l))}
            </td>
            <td className="num">{money(m.share(l))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MfgView({ a, accounts }) {
  const m = mfgCosts(a.lines, a.additionalCosts || []);
  const made = a.lines.filter((l) => l.quantityAdjusted > 0);
  const used = a.lines.filter((l) => l.quantityAdjusted < 0);
  return (
    <div className="card">
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Manufacture of materials
      </h4>
      <div className="mfg-grid">
        <div>
          <div className="label-sm">Components (consumption)</div>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {used.map((l, i) => (
                <tr key={i}>
                  <td>
                    <Link to={`/items/${l.item}`}>{l.name}</Link>
                  </td>
                  <td className="num">{-l.quantityAdjusted}</td>
                  <td className="num">{money(l.rate)}</td>
                  <td className="num">
                    {money(-l.quantityAdjusted * (l.rate || 0))}
                  </td>
                </tr>
              ))}
              <tr className="strong">
                <td colSpan={3}>Cost of components</td>
                <td className="num">{money(m.components)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="label-sm">Product / by-product / scrap</div>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">% of cost</th>
                <th className="num">Quantity</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {made.map((l, i) => (
                <tr key={i}>
                  <td>
                    <Link to={`/items/${l.item}`}>{l.name}</Link>
                  </td>
                  <td className="num">{r2(m.pctOf(l))}%</td>
                  <td className="num">{l.quantityAdjusted}</td>
                  <td className="num">{money(l.costPrice)}</td>
                  <td className="num">
                    {money(l.quantityAdjusted * l.costPrice)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="label-sm">Additional costs</div>
          <table className="table">
            <tbody>
              {m.costs.map((c, i) => (
                <tr key={i}>
                  <td>{c.name || accountName(accounts, c.account)}</td>
                  <td className="num">{c.percent ? `${c.percent}%` : ""}</td>
                  <td className="num">{money(c.value)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>Total additional cost</td>
                <td className="num">{money(m.addl)}</td>
              </tr>
              <tr className="strong">
                <td colSpan={2}>Effective cost</td>
                <td className="num">{money(m.effective)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
