import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES, GST_RATES, PAYMENT_TERMS, stateName } from "../lib/constants";
import { CREDIT_REASONS, VENDOR_CREDIT_REASONS } from "../lib/docKinds";
import { money, amount, date, isoDate, addDays, round2, inWords } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Status } from "./ui";
import Icon from "./Icon";
import { LogoMark } from "./Logo";

/* ======================= List ======================= */
export function DocList({ kind, filters, columns, emptyText, summary }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    setRows(null);
    api.get(kind.api, { params: { q: dq, status } }).then((r) => setRows(r.data));
  }, [dq, status, kind.api]);

  return (
    <>
      <PageHeader title={kind.plural}>
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          {filters.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${kind.plural.toLowerCase()}`} />
        <Link to={`${kind.route}/new`} className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="doc"
          title={q || status !== "all" ? `No ${kind.plural.toLowerCase()} found` : `Create your first ${kind.label.toLowerCase()}`}
          text={emptyText}
          action={
            <Link to={`${kind.route}/new`} className="btn btn-primary">
              New {kind.label}
            </Link>
          }
        />
      ) : (
        <>
          {summary && <div className="summary-strip">{summary(rows)}</div>}
          <div className="card flush">
            <table className="table table-click">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.label} className={c.num ? "num" : ""}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id} onClick={() => navigate(`${kind.route}/${r._id}`)}>
                    {columns.map((c) => (
                      <td key={c.label} className={`${c.num ? "num" : ""} ${c.cls || ""}`}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/* ======================= Form ======================= */
const blankLine = () => ({ item: "", name: "", description: "", hsnSac: "", unit: "", quantity: 1, rate: 0, discount: 0, taxRate: 18 });
const lineAmount = (l) => round2((Number(l.quantity) || 0) * (Number(l.rate) || 0) * (1 - (Number(l.discount) || 0) / 100));
const cleanLine = (l) => ({
  item: l.item || "",
  name: l.name,
  description: l.description || "",
  hsnSac: l.hsnSac || "",
  unit: l.unit || "",
  quantity: l.quantity,
  rate: l.rate,
  discount: l.discount || 0,
  taxRate: l.taxRate || 0,
});

function calc(lines, orgState, pos, shipping, adjustment) {
  const inter = Boolean(pos) && Boolean(orgState) && pos !== orgState;
  let sub = 0;
  const taxByRate = {};
  for (const l of lines) {
    const amt = lineAmount(l);
    sub += amt;
    const r = Number(l.taxRate) || 0;
    if (!r) continue;
    const tax = (amt * r) / 100;
    taxByRate[r] = taxByRate[r] || { cgst: 0, sgst: 0, igst: 0 };
    if (inter) taxByRate[r].igst += round2(tax);
    else {
      taxByRate[r].cgst += round2(tax / 2);
      taxByRate[r].sgst += round2(tax / 2);
    }
  }
  const taxTotal = round2(Object.values(taxByRate).reduce((s, t) => s + t.cgst + t.sgst + t.igst, 0));
  const total = round2(sub + taxTotal + (Number(shipping) || 0) + (Number(adjustment) || 0));
  return { inter, sub: round2(sub), taxByRate, total };
}

export function DocForm({ kind }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [custInvoices, setCustInvoices] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoNumber, setAutoNumber] = useState("");
  // Credit notes (customers) and vendor credits (vendors) can point at an invoice / bill.
  const isCN = kind.key === "creditNote" || kind.key === "vendorCredit";
  const second = kind.second;
  const party = kind.party || "customer";
  const isVendor = party === "vendor";
  const partyApi = isVendor ? "/vendors" : "/customers";
  const linkKey = isVendor ? "bill" : "invoice";
  const linkApi = isVendor ? "/bills" : "/invoices";
  const linkNumber = isVendor ? "billNumber" : "invoiceNumber";

  useEffect(() => {
    api.get(partyApi, { params: { status: "active" } }).then((r) => setCustomers(r.data));
    api.get("/items", { params: { status: "active" } }).then((r) => setItems(r.data));
  }, [partyApi]);

  useEffect(() => {
    if (id) {
      api.get(`${kind.api}/${id}`).then(({ data }) => {
        const f = {
          customer: data[party],
          number: data[kind.numberField] || "",
          ref: data[kind.refField] || "",
          date: isoDate(data.date),
          paymentTerms: data.paymentTerms ?? 0,
          second: second && data[second.field] ? isoDate(data[second.field]) : "",
          placeOfSupply: data.placeOfSupply,
          lineItems: data.lineItems.map(cleanLine),
          shippingCharge: data.shippingCharge,
          adjustment: data.adjustment,
          customerNotes: data.customerNotes,
          terms: data.terms,
          status: data.status,
          invoice: data.invoice || data.bill || "",
          reason: data.reason || "",
        };
        setForm(f);
      });
      return;
    }
    if (kind.numberAuto !== false) api.get(`${kind.api}/next-number`).then((r) => setAutoNumber(r.data.number));
    const terms = organization?.defaultPaymentTerms ?? 15;
    const today = isoDate();
    const base = {
      customer: params.get(party) || "",
      number: "",
      ref: "",
      date: today,
      paymentTerms: terms,
      second: second?.terms ? addDays(today, terms) : second?.defaultDays ? addDays(today, second.defaultDays) : "",
      placeOfSupply: "",
      lineItems: [blankLine()],
      shippingCharge: 0,
      adjustment: 0,
      customerNotes: isCN || isVendor ? "" : organization?.defaultNotes || "",
      terms: isCN || isVendor ? "" : organization?.defaultTerms || "",
      status: "draft",
      invoice: "",
      reason: isCN ? (isVendor ? "Purchase Return" : "Sales Return") : "",
      purchaseOrder: "",
    };
    const fromInvoice = isCN && params.get(linkKey);
    const fromPO = kind.key === "bill" && params.get("po");
    if (fromInvoice) {
      api.get(`${linkApi}/${fromInvoice}`).then(({ data }) =>
        setForm({
          ...base,
          customer: data[party],
          invoice: data._id,
          placeOfSupply: data.placeOfSupply,
          lineItems: data.lineItems.map(cleanLine),
        })
      );
    } else if (fromPO) {
      api.get(`/purchase-orders/${fromPO}`).then(({ data }) =>
        setForm({
          ...base,
          customer: data.vendor,
          ref: data.number,
          purchaseOrder: data._id,
          placeOfSupply: data.placeOfSupply,
          lineItems: data.lineItems.map(cleanLine),
          shippingCharge: data.shippingCharge,
          adjustment: data.adjustment,
        })
      );
    } else setForm(base);
  }, [id, kind, organization, params, second, isCN, party, isVendor, linkKey, linkApi]);

  // Customer picked from the URL: apply their defaults once customers load.
  useEffect(() => {
    if (!id && form && form.customer && !form.placeOfSupply && customers.length) {
      const c = customers.find((x) => x._id === form.customer);
      if (c)
        setForm((f) => ({
          ...f,
          placeOfSupply: c.placeOfSupply || organization?.state || "",
          paymentTerms: c.paymentTerms,
          second: second?.terms ? addDays(f.date, c.paymentTerms) : f.second,
        }));
    }
  }, [customers, form, id, organization, second]);

  // Credit notes / vendor credits: load the party's invoices or bills to reference.
  useEffect(() => {
    if (!isCN || !form?.customer) return setCustInvoices([]);
    api.get(linkApi, { params: { [party]: form.customer } }).then((r) => setCustInvoices(r.data.filter((i) => i.status !== "draft")));
  }, [isCN, form?.customer, linkApi, party]);

  const totals = useMemo(
    () => (form ? calc(form.lineItems, organization?.state, form.placeOfSupply || organization?.state, form.shippingCharge, form.adjustment) : null),
    [form, organization]
  );

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const customer = customers.find((c) => c._id === form.customer);

  const pickCustomer = (e) => {
    const c = customers.find((x) => x._id === e.target.value);
    setForm({
      ...form,
      customer: e.target.value,
      invoice: "",
      placeOfSupply: c?.placeOfSupply || organization?.state || "",
      paymentTerms: c ? c.paymentTerms : form.paymentTerms,
      second: second?.terms && c ? addDays(form.date, c.paymentTerms) : form.second,
    });
  };

  const setLine = (i, patch) => setForm({ ...form, lineItems: form.lineItems.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const pickItem = (i, itemId) => {
    const it = items.find((x) => x._id === itemId);
    if (!it) return setLine(i, { item: "" });
    const rate = isVendor ? it.purchaseRate || it.rate : it.rate;
    setLine(i, { item: it._id, name: it.name, description: it.description, hsnSac: it.hsnSac, unit: it.unit, rate, taxRate: it.taxRate });
  };

  const submit = async (status) => {
    const formEl = document.querySelector(".doc-form");
    if (formEl && !formEl.reportValidity()) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        [party]: form.customer,
        [kind.numberField]: form.number,
        [kind.refField]: form.ref,
        date: form.date,
        placeOfSupply: form.placeOfSupply,
        shippingCharge: Number(form.shippingCharge || 0),
        adjustment: Number(form.adjustment || 0),
        customerNotes: form.customerNotes,
        terms: form.terms,
        status,
        lineItems: form.lineItems
          .filter((l) => l.name.trim())
          .map((l) => ({
            ...l,
            item: l.item || null,
            quantity: Number(l.quantity),
            rate: Number(l.rate),
            discount: Number(l.discount || 0),
            taxRate: Number(l.taxRate || 0),
          })),
      };
      if (second) body[second.field] = form.second || null;
      if (second?.terms) body.paymentTerms = Number(form.paymentTerms);
      if (isCN) {
        body[linkKey] = form.invoice || null;
        body.reason = form.reason;
      }
      if (form.purchaseOrder) body.purchaseOrder = form.purchaseOrder;
      const { data } = id ? await api.put(`${kind.api}/${id}`, body) : await api.post(kind.api, body);
      toast(`${kind.label} ${id ? "updated" : "created"}`);
      navigate(`${kind.route}/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  const isDraft = !id || form.status === "draft";
  const title = id ? `Edit ${form.number}` : `New ${kind.label}`;

  return (
    <>
      <PageHeader title={title} back={id ? `${kind.route}/${id}` : kind.route} />
      <form className="card form doc-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-grid">
          <Field label={isVendor ? "Vendor Name" : "Customer Name"} required>
            <div className="inline-add">
              <select required value={form.customer} onChange={pickCustomer}>
                <option value="">Select or add a {party}</option>
                {customers.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <Link to={`${partyApi}/new`} className="btn btn-sm" title={`New ${party}`}>
                <Icon name="plus" size={14} />
              </Link>
            </div>
          </Field>
          {customer && (
            <div className="customer-chip">
              {customer.gstin && (
                <span>
                  GSTIN: <b className="mono">{customer.gstin}</b>
                </span>
              )}
              <span>
                {isVendor ? "Payables" : "Receivables"}: <b>{money(isVendor ? customer.payables : customer.receivables)}</b>
              </span>
            </div>
          )}
          <Field label={isVendor ? "Source of Supply" : "Place of Supply"} required>
            <select value={form.placeOfSupply} onChange={set("placeOfSupply")} required>
              <option value="">Select</option>
              {STATES.map(([c, n]) => (
                <option key={c} value={c}>
                  [{c}] {n}
                </option>
              ))}
            </select>
          </Field>
          {isCN && (
            <div className="row-2">
              <Field label={isVendor ? "Bill#" : "Invoice#"} hint={`The ${linkKey} this credit is for (optional)`}>
                <select value={form.invoice} onChange={set("invoice")}>
                  <option value="">None</option>
                  {custInvoices.map((i) => (
                    <option key={i._id} value={i._id}>
                      {i[linkNumber]} — {money(i.total)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason">
                <select value={form.reason} onChange={set("reason")}>
                  {(isVendor ? VENDOR_CREDIT_REASONS : CREDIT_REASONS).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <div className="row-2">
            <Field label={kind.numberLabel} required>
              <input
                value={form.number}
                required={kind.numberAuto === false}
                placeholder={kind.numberAuto === false ? "" : autoNumber || "Auto-generated"}
                onChange={set("number")}
              />
            </Field>
            <Field label={kind.refLabel}>
              <input value={form.ref} onChange={set("ref")} />
            </Field>
          </div>
          <div className={second?.terms ? "row-3" : "row-2"}>
            <Field label={kind.dateLabel} required>
              <input
                type="date"
                required
                value={form.date}
                onChange={(e) =>
                  setForm({ ...form, date: e.target.value, second: second?.terms ? addDays(e.target.value, form.paymentTerms) : form.second })
                }
              />
            </Field>
            {second?.terms && (
              <Field label="Terms">
                <select
                  value={form.paymentTerms}
                  onChange={(e) => setForm({ ...form, paymentTerms: e.target.value, second: addDays(form.date, e.target.value) })}
                >
                  {PAYMENT_TERMS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                  {!PAYMENT_TERMS.some(([v]) => v === Number(form.paymentTerms)) && <option value={form.paymentTerms}>Net {form.paymentTerms}</option>}
                </select>
              </Field>
            )}
            {second && (
              <Field label={second.label} required={second.required}>
                <input type="date" required={second.required} value={form.second} min={form.date} onChange={set("second")} />
              </Field>
            )}
          </div>
        </div>

        <h4 className="section-title">
          Item Table
          <span className="muted small">{totals.inter ? "Inter-state supply · IGST" : "Intra-state supply · CGST + SGST"}</span>
        </h4>
        <div className="line-table-wrap">
          <table className="line-table">
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Item Details</th>
                <th>Quantity</th>
                <th>Rate (₹)</th>
                <th>Discount %</th>
                <th>GST</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.lineItems.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select className="item-pick" value={l.item} onChange={(e) => pickItem(i, e.target.value)}>
                      <option value="">Type or pick an item…</option>
                      {items.map((it) => (
                        <option key={it._id} value={it._id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                    <input placeholder="Item name" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} required={i === 0} />
                    <input className="small-input" placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                    <input className="small-input mono" placeholder="HSN/SAC" value={l.hsnSac} onChange={(e) => setLine(i, { hsnSac: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" step="any" min="0" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                    {l.unit && <span className="muted small">{l.unit}</span>}
                  </td>
                  <td>
                    <input type="number" step="0.01" min="0" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" step="0.01" min="0" max="100" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
                  </td>
                  <td>
                    <select value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })}>
                      {GST_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num strong">{amount(lineAmount(l))}</td>
                  <td>
                    {form.lineItems.length > 1 && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="Remove row"
                        onClick={() => setForm({ ...form, lineItems: form.lineItems.filter((_, j) => j !== i) })}
                      >
                        <Icon name="x" size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, lineItems: [...form.lineItems, blankLine()] })}>
          <Icon name="plus" size={14} /> Add another line
        </button>

        <div className="invoice-bottom">
          <div className="stack">
            <Field label={isVendor ? "Notes" : "Customer Notes"} hint={isVendor ? "Internal note, not shown to the vendor" : undefined}>
              <textarea rows={3} value={form.customerNotes} onChange={set("customerNotes")} />
            </Field>
            {!isVendor && (
              <Field label="Terms & Conditions">
                <textarea rows={3} value={form.terms} onChange={set("terms")} />
              </Field>
            )}
          </div>
          <div className="totals-box">
            <div className="tot-row">
              <span>Sub Total</span>
              <span>{amount(totals.sub)}</span>
            </div>
            {Object.entries(totals.taxByRate).map(([r, t]) =>
              totals.inter ? (
                <div className="tot-row muted" key={r}>
                  <span>IGST [{r}%]</span>
                  <span>{amount(t.igst)}</span>
                </div>
              ) : (
                <div key={r}>
                  <div className="tot-row muted">
                    <span>CGST [{r / 2}%]</span>
                    <span>{amount(t.cgst)}</span>
                  </div>
                  <div className="tot-row muted">
                    <span>SGST [{r / 2}%]</span>
                    <span>{amount(t.sgst)}</span>
                  </div>
                </div>
              )
            )}
            <div className="tot-row">
              <span>Shipping Charges</span>
              <input type="number" step="0.01" min="0" value={form.shippingCharge} onChange={set("shippingCharge")} />
            </div>
            <div className="tot-row">
              <span>Adjustment</span>
              <input type="number" step="0.01" value={form.adjustment} onChange={set("adjustment")} />
            </div>
            <div className="tot-row tot-total">
              <span>Total (₹)</span>
              <span>{amount(totals.total)}</span>
            </div>
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer sticky-footer">
          {isDraft ? (
            kind.saveButtons.map((b) => (
              <button key={b.status} type="button" className={`btn ${b.primary ? "btn-primary" : ""}`} disabled={busy} onClick={() => submit(b.status)}>
                {b.label}
              </button>
            ))
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submit(form.status)}>
              Save
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

/* ======================= Printable document ======================= */
function Addr({ a = {} }) {
  const lines = [a.street, a.city, [stateName(a.state), a.pincode].filter(Boolean).join(" "), a.country].filter(Boolean);
  return lines.map((l, i) => <div key={i}>{l}</div>);
}

export function DocPaper({ doc, org, title, number, meta = [], ribbon, balance, extraTotals = [], extraInfo = [], partyLabel = "Bill To" }) {
  const taxRows = {};
  doc.lineItems.forEach((l) => {
    if (!l.taxRate) return;
    taxRows[l.taxRate] = taxRows[l.taxRate] || { cgst: 0, sgst: 0, igst: 0 };
    taxRows[l.taxRate].cgst += l.cgst;
    taxRows[l.taxRate].sgst += l.sgst;
    taxRows[l.taxRate].igst += l.igst;
  });
  return (
    <div className="invoice-doc">
      {ribbon && <div className={`ribbon ribbon-${ribbon.cls}`}>{ribbon.text}</div>}
      <div className="doc-head">
        <div className="doc-brand">
          <LogoMark size={36} />
          <div>
            <h2>{org.name}</h2>
            <div className="doc-small">
              <Addr a={org.address} />
              {org.gstin && <div>GSTIN {org.gstin}</div>}
              {org.phone && <div>{org.phone}</div>}
              {org.email && <div>{org.email}</div>}
            </div>
          </div>
        </div>
        <div className="doc-title">
          <h1>{title}</h1>
          <div className="doc-small"># {number}</div>
          {balance && (
            <div className="doc-balance">
              <span>{balance.label}</span>
              <strong>{money(balance.value)}</strong>
            </div>
          )}
        </div>
      </div>

      <div className="doc-meta">
        <div>
          <div className="doc-label">{partyLabel}</div>
          <strong>{doc.customerName || doc.vendorName}</strong>
          <div className="doc-small">
            <Addr a={doc.billingAddress} />
            {(doc.customerGstin || doc.vendorGstin) && <div>GSTIN {doc.customerGstin || doc.vendorGstin}</div>}
          </div>
        </div>
        <table className="doc-kv">
          <tbody>
            {meta
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <tr key={k}>
                  <td>{k} :</td>
                  <td>{v}</td>
                </tr>
              ))}
            <tr>
              <td>{doc.vendorName ? "Source of Supply" : "Place of Supply"} :</td>
              <td>
                {stateName(doc.placeOfSupply)} ({doc.placeOfSupply})
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <table className="doc-items">
        <thead>
          <tr>
            <th>#</th>
            <th>Item & Description</th>
            <th>HSN/SAC</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            {doc.isInterState ? (
              <th className="num">IGST</th>
            ) : (
              <>
                <th className="num">CGST</th>
                <th className="num">SGST</th>
              </>
            )}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lineItems.map((l, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>
                <strong>{l.name}</strong>
                {l.description && <div className="doc-small">{l.description}</div>}
                {l.discount > 0 && <div className="doc-small">Discount {l.discount}%</div>}
              </td>
              <td>{l.hsnSac}</td>
              <td className="num">
                {l.quantity} {l.unit}
              </td>
              <td className="num">{amount(l.rate)}</td>
              {doc.isInterState ? (
                <td className="num">
                  {amount(l.igst)}
                  <div className="doc-small">{l.taxRate}%</div>
                </td>
              ) : (
                <>
                  <td className="num">
                    {amount(l.cgst)}
                    <div className="doc-small">{l.taxRate / 2}%</div>
                  </td>
                  <td className="num">
                    {amount(l.sgst)}
                    <div className="doc-small">{l.taxRate / 2}%</div>
                  </td>
                </>
              )}
              <td className="num">{amount(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="doc-foot">
        <div className="doc-words">
          <div className="doc-label">Total In Words</div>
          <em>{inWords(doc.total)}</em>
          {extraInfo.map(([k, v]) => (
            <div key={k}>
              <div className="doc-label">{k}</div>
              <p>{v}</p>
            </div>
          ))}
          {doc.customerNotes && (
            <>
              <div className="doc-label">Notes</div>
              <p>{doc.customerNotes}</p>
            </>
          )}
          {doc.terms && (
            <>
              <div className="doc-label">Terms & Conditions</div>
              <p className="pre">{doc.terms}</p>
            </>
          )}
        </div>
        <table className="doc-totals">
          <tbody>
            <tr>
              <td>Sub Total</td>
              <td>{amount(doc.subTotal)}</td>
            </tr>
            {Object.entries(taxRows).map(([r, t]) =>
              doc.isInterState ? (
                <tr key={r}>
                  <td>
                    IGST{r} ({r}%)
                  </td>
                  <td>{amount(t.igst)}</td>
                </tr>
              ) : (
                [
                  <tr key={`c${r}`}>
                    <td>
                      CGST{r / 2} ({r / 2}%)
                    </td>
                    <td>{amount(t.cgst)}</td>
                  </tr>,
                  <tr key={`s${r}`}>
                    <td>
                      SGST{r / 2} ({r / 2}%)
                    </td>
                    <td>{amount(t.sgst)}</td>
                  </tr>,
                ]
              )
            )}
            {doc.shippingCharge ? (
              <tr>
                <td>Shipping Charge</td>
                <td>{amount(doc.shippingCharge)}</td>
              </tr>
            ) : null}
            {doc.adjustment ? (
              <tr>
                <td>Adjustment</td>
                <td>{amount(doc.adjustment)}</td>
              </tr>
            ) : null}
            <tr className="doc-grand">
              <td>Total</td>
              <td>{money(doc.total)}</td>
            </tr>
            {extraTotals.map(([k, v, cls]) => (
              <tr key={k} className={cls || ""}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="doc-sign">Authorized Signature</div>
    </div>
  );
}

/* Reusable list table for a small set of related records. */
export function MiniTable({ title, columns, rows, empty = "None" }) {
  return (
    <div className="card no-print payments-panel">
      <h3>{title}</h3>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.num ? "num" : ""}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r._id || i}>
              {columns.map((c) => (
                <td key={c.label} className={c.num ? "num" : ""}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length} className="muted center">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export const dateCol = (label = "Date", field = "date") => ({ label, render: (r) => date(r[field]) });
export const statusCol = { label: "Status", render: (r) => <Status value={r.displayStatus || r.status} /> };
export const moneyCol = (label, field) => ({ label, num: true, render: (r) => money(r[field]) });
