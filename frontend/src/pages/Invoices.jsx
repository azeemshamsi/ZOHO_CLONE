import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES, GST_RATES, PAYMENT_TERMS, stateName, modeName } from "../lib/constants";
import { money, amount, date, isoDate, addDays, round2, inWords } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Status, Confirm } from "../components/ui";
import Icon from "../components/Icon";
import { LogoMark } from "../components/Logo";

/* ================= List ================= */
const FILTERS = [
  ["all", "All Invoices"],
  ["draft", "Draft"],
  ["unpaid", "Unpaid"],
  ["overdue", "Overdue"],
  ["partially_paid", "Partially Paid"],
  ["paid", "Paid"],
  ["void", "Void"],
];

export function InvoiceList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/invoices", { params: { q: dq, status } }).then((r) => setRows(r.data));
  }, [dq, status]);

  const totalDue = rows ? rows.filter((r) => r.status !== "void" && r.status !== "draft").reduce((s, r) => s + r.balance, 0) : 0;

  return (
    <>
      <PageHeader title="Invoices">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Search invoices" />
        <Link to="/invoices/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="doc"
          title={q || status !== "all" ? "No invoices found" : "Create your first invoice"}
          text="GST is worked out automatically from your state and the customer's place of supply."
          action={
            <Link to="/invoices/new" className="btn btn-primary">
              New Invoice
            </Link>
          }
        />
      ) : (
        <>
          <div className="summary-strip">
            <span className="muted">{rows.length} invoices</span>
            <span>
              Balance due: <strong>{money(totalDue)}</strong>
            </span>
          </div>
          <div className="card flush">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Invoice#</th>
                  <th>Order Number</th>
                  <th>Customer Name</th>
                  <th>Status</th>
                  <th>Due Date</th>
                  <th className="num">Amount</th>
                  <th className="num">Balance Due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i._id} onClick={() => navigate(`/invoices/${i._id}`)}>
                    <td>{date(i.date)}</td>
                    <td className="link strong">{i.invoiceNumber}</td>
                    <td>{i.orderNumber}</td>
                    <td>{i.customerName}</td>
                    <td>
                      <Status value={i.displayStatus} />
                    </td>
                    <td>{date(i.dueDate)}</td>
                    <td className="num">{money(i.total)}</td>
                    <td className="num">{money(i.balance)}</td>
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

/* ================= Form ================= */
const blankLine = () => ({ item: "", name: "", description: "", hsnSac: "", unit: "", quantity: 1, rate: 0, discount: 0, taxRate: 18 });

function calc(lines, orgState, pos, shipping, adjustment) {
  const inter = Boolean(pos) && Boolean(orgState) && pos !== orgState;
  let sub = 0;
  const taxByRate = {};
  for (const l of lines) {
    const amt = round2((Number(l.quantity) || 0) * (Number(l.rate) || 0) * (1 - (Number(l.discount) || 0) / 100));
    sub += amt;
    const r = Number(l.taxRate) || 0;
    if (r) {
      const tax = (amt * r) / 100;
      taxByRate[r] = taxByRate[r] || { cgst: 0, sgst: 0, igst: 0 };
      if (inter) taxByRate[r].igst += round2(tax);
      else {
        taxByRate[r].cgst += round2(tax / 2);
        taxByRate[r].sgst += round2(tax / 2);
      }
    }
  }
  const taxTotal = round2(Object.values(taxByRate).reduce((s, t) => s + t.cgst + t.sgst + t.igst, 0));
  const total = round2(sub + taxTotal + (Number(shipping) || 0) + (Number(adjustment) || 0));
  return { inter, sub: round2(sub), taxByRate, taxTotal, total };
}

const lineAmount = (l) => round2((Number(l.quantity) || 0) * (Number(l.rate) || 0) * (1 - (Number(l.discount) || 0) / 100));

export function InvoiceForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoNumber, setAutoNumber] = useState("");

  useEffect(() => {
    api.get("/customers", { params: { status: "active" } }).then((r) => setCustomers(r.data));
    api.get("/items", { params: { status: "active" } }).then((r) => setItems(r.data));
    if (id) {
      api.get(`/invoices/${id}`).then(({ data }) =>
        setForm({
          customer: data.customer,
          invoiceNumber: data.invoiceNumber,
          orderNumber: data.orderNumber,
          date: isoDate(data.date),
          paymentTerms: data.paymentTerms,
          dueDate: isoDate(data.dueDate),
          placeOfSupply: data.placeOfSupply,
          lineItems: data.lineItems.map((l) => ({ ...l, item: l.item || "" })),
          shippingCharge: data.shippingCharge,
          adjustment: data.adjustment,
          customerNotes: data.customerNotes,
          terms: data.terms,
          status: data.status,
        })
      );
    } else {
      api.get("/invoices/next-number").then((r) => setAutoNumber(r.data.invoiceNumber));
      const terms = organization?.defaultPaymentTerms ?? 15;
      setForm({
        customer: params.get("customer") || "",
        invoiceNumber: "",
        orderNumber: "",
        date: isoDate(),
        paymentTerms: terms,
        dueDate: addDays(new Date(), terms),
        placeOfSupply: "",
        lineItems: [blankLine()],
        shippingCharge: 0,
        adjustment: 0,
        customerNotes: organization?.defaultNotes || "",
        terms: organization?.defaultTerms || "",
        status: "draft",
      });
    }
  }, [id, organization, params]);

  // When the customer is picked from the URL, fill in their defaults once loaded.
  useEffect(() => {
    if (!id && form && form.customer && !form.placeOfSupply && customers.length) {
      const c = customers.find((x) => x._id === form.customer);
      if (c) setForm((f) => ({ ...f, placeOfSupply: c.placeOfSupply || organization?.state || "", paymentTerms: c.paymentTerms, dueDate: addDays(f.date, c.paymentTerms) }));
    }
  }, [customers, form, id, organization]);

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
      placeOfSupply: c?.placeOfSupply || organization?.state || "",
      paymentTerms: c ? c.paymentTerms : form.paymentTerms,
      dueDate: c ? addDays(form.date, c.paymentTerms) : form.dueDate,
    });
  };

  const setLine = (i, patch) => setForm({ ...form, lineItems: form.lineItems.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const pickItem = (i, itemId) => {
    const it = items.find((x) => x._id === itemId);
    if (!it) return setLine(i, { item: "" });
    setLine(i, { item: it._id, name: it.name, description: it.description, hsnSac: it.hsnSac, unit: it.unit, rate: it.rate, taxRate: it.taxRate });
  };

  const submit = async (status) => {
    const formEl = document.querySelector(".invoice-form");
    if (formEl && !formEl.reportValidity()) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        ...form,
        status,
        paymentTerms: Number(form.paymentTerms),
        shippingCharge: Number(form.shippingCharge || 0),
        adjustment: Number(form.adjustment || 0),
        lineItems: form.lineItems
          .filter((l) => l.name.trim())
          .map((l) => ({
            item: l.item || null,
            name: l.name,
            description: l.description || "",
            hsnSac: l.hsnSac || "",
            unit: l.unit || "",
            quantity: Number(l.quantity),
            rate: Number(l.rate),
            discount: Number(l.discount || 0),
            taxRate: Number(l.taxRate || 0),
          })),
      };
      const { data } = id ? await api.put(`/invoices/${id}`, body) : await api.post("/invoices", body);
      toast(id ? "Invoice updated" : "Invoice created");
      navigate(`/invoices/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? `Edit ${form.invoiceNumber}` : "New Invoice"} back={id ? `/invoices/${id}` : "/invoices"} />
      <form className="card form invoice-form" onSubmit={(e) => (e.preventDefault(), submit(form.status === "draft" ? "draft" : "sent"))}>
        <div className="form-grid">
          <Field label="Customer Name" required>
            <div className="inline-add">
              <select required value={form.customer} onChange={pickCustomer}>
                <option value="">Select or add a customer</option>
                {customers.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <Link to="/customers/new" className="btn btn-sm" title="New customer">
                <Icon name="plus" size={14} />
              </Link>
            </div>
          </Field>
          {customer && (
            <div className="customer-chip">
              {customer.gstin && <span>GSTIN: <b className="mono">{customer.gstin}</b></span>}
              <span>Receivables: <b>{money(customer.receivables)}</b></span>
            </div>
          )}
          <Field label="Place of Supply" required>
            <select value={form.placeOfSupply} onChange={set("placeOfSupply")} required>
              <option value="">Select</option>
              {STATES.map(([c, n]) => (
                <option key={c} value={c}>
                  [{c}] {n}
                </option>
              ))}
            </select>
          </Field>
          <div className="row-2">
            <Field label="Invoice#" required>
              <input value={form.invoiceNumber} placeholder={autoNumber || "Auto-generated"} onChange={set("invoiceNumber")} />
            </Field>
            <Field label="Order Number">
              <input value={form.orderNumber} onChange={set("orderNumber")} />
            </Field>
          </div>
          <div className="row-3">
            <Field label="Invoice Date" required>
              <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, dueDate: addDays(e.target.value, form.paymentTerms) })} />
            </Field>
            <Field label="Terms">
              <select value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value, dueDate: addDays(form.date, e.target.value) })}>
                {PAYMENT_TERMS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                {!PAYMENT_TERMS.some(([v]) => v === Number(form.paymentTerms)) && <option value={form.paymentTerms}>Net {form.paymentTerms}</option>}
              </select>
            </Field>
            <Field label="Due Date" required>
              <input type="date" required value={form.dueDate} min={form.date} onChange={set("dueDate")} />
            </Field>
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
                      <button type="button" className="icon-btn" title="Remove row" onClick={() => setForm({ ...form, lineItems: form.lineItems.filter((_, j) => j !== i) })}>
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
            <Field label="Customer Notes">
              <textarea rows={3} value={form.customerNotes} onChange={set("customerNotes")} />
            </Field>
            <Field label="Terms & Conditions">
              <textarea rows={3} value={form.terms} onChange={set("terms")} />
            </Field>
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
          {(!id || form.status === "draft") && (
            <button type="button" className="btn" disabled={busy} onClick={() => submit("draft")}>
              Save as Draft
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submit("sent")}>
            {!id || form.status === "draft" ? "Save and Mark as Sent" : "Save"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

/* ================= Detail / Print ================= */
function Addr({ a = {} }) {
  const lines = [a.street, a.city, [stateName(a.state), a.pincode].filter(Boolean).join(" "), a.country].filter(Boolean);
  return lines.map((l, i) => <div key={i}>{l}</div>);
}

export function InvoiceDocument({ inv, org }) {
  const taxRows = {};
  inv.lineItems.forEach((l) => {
    if (!l.taxRate) return;
    taxRows[l.taxRate] = taxRows[l.taxRate] || { cgst: 0, sgst: 0, igst: 0 };
    taxRows[l.taxRate].cgst += l.cgst;
    taxRows[l.taxRate].sgst += l.sgst;
    taxRows[l.taxRate].igst += l.igst;
  });
  return (
    <div className="invoice-doc">
      {inv.displayStatus !== "draft" && (
        <div className={`ribbon ribbon-${inv.displayStatus}`}>{inv.displayStatus === "sent" ? "unpaid" : inv.displayStatus.replace("_", " ")}</div>
      )}
      <div className="doc-head">
        <div>
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
        </div>
        <div className="doc-title">
          <h1>TAX INVOICE</h1>
          <div className="doc-small"># {inv.invoiceNumber}</div>
          <div className="doc-balance">
            <span>Balance Due</span>
            <strong>{money(inv.balance)}</strong>
          </div>
        </div>
      </div>

      <div className="doc-meta">
        <div>
          <div className="doc-label">Bill To</div>
          <strong>{inv.customerName}</strong>
          <div className="doc-small">
            <Addr a={inv.billingAddress} />
            {inv.customerGstin && <div>GSTIN {inv.customerGstin}</div>}
          </div>
        </div>
        <table className="doc-kv">
          <tbody>
            <tr>
              <td>Invoice Date :</td>
              <td>{date(inv.date)}</td>
            </tr>
            <tr>
              <td>Terms :</td>
              <td>{(PAYMENT_TERMS.find((p) => p[0] === inv.paymentTerms) || [0, `Net ${inv.paymentTerms}`])[1]}</td>
            </tr>
            <tr>
              <td>Due Date :</td>
              <td>{date(inv.dueDate)}</td>
            </tr>
            {inv.orderNumber && (
              <tr>
                <td>Order# :</td>
                <td>{inv.orderNumber}</td>
              </tr>
            )}
            <tr>
              <td>Place of Supply :</td>
              <td>
                {stateName(inv.placeOfSupply)} ({inv.placeOfSupply})
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
            {inv.isInterState ? <th className="num">IGST</th> : (
              <>
                <th className="num">CGST</th>
                <th className="num">SGST</th>
              </>
            )}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lineItems.map((l, i) => (
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
              {inv.isInterState ? (
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
          <em>{inWords(inv.total)}</em>
          {inv.customerNotes && (
            <>
              <div className="doc-label">Notes</div>
              <p>{inv.customerNotes}</p>
            </>
          )}
          {inv.terms && (
            <>
              <div className="doc-label">Terms & Conditions</div>
              <p className="pre">{inv.terms}</p>
            </>
          )}
        </div>
        <table className="doc-totals">
          <tbody>
            <tr>
              <td>Sub Total</td>
              <td>{amount(inv.subTotal)}</td>
            </tr>
            {Object.entries(taxRows).map(([r, t]) =>
              inv.isInterState ? (
                <tr key={r}>
                  <td>IGST{r} ({r}%)</td>
                  <td>{amount(t.igst)}</td>
                </tr>
              ) : (
                [
                  <tr key={`c${r}`}>
                    <td>CGST{r / 2} ({r / 2}%)</td>
                    <td>{amount(t.cgst)}</td>
                  </tr>,
                  <tr key={`s${r}`}>
                    <td>SGST{r / 2} ({r / 2}%)</td>
                    <td>{amount(t.sgst)}</td>
                  </tr>,
                ]
              )
            )}
            {inv.shippingCharge ? (
              <tr>
                <td>Shipping Charge</td>
                <td>{amount(inv.shippingCharge)}</td>
              </tr>
            ) : null}
            {inv.adjustment ? (
              <tr>
                <td>Adjustment</td>
                <td>{amount(inv.adjustment)}</td>
              </tr>
            ) : null}
            <tr className="doc-grand">
              <td>Total</td>
              <td>{money(inv.total)}</td>
            </tr>
            {inv.amountPaid > 0 && (
              <tr>
                <td>Payment Made</td>
                <td className="text-paid">(-) {amount(inv.amountPaid)}</td>
              </tr>
            )}
            <tr className="doc-grand">
              <td>Balance Due</td>
              <td>{money(inv.balance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="doc-sign">Authorized Signature</div>
    </div>
  );
}

export function InvoiceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [inv, setInv] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api.get(`/invoices/${id}`).then((r) => setInv(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!inv || !organization) return <Spinner />;

  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      setConfirm(null);
      load();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={inv.invoiceNumber} subtitle={inv.customerName} back="/invoices">
        {inv.status !== "void" && (
          <Link to={`/invoices/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        {inv.status === "draft" && (
          <button className="btn" onClick={() => act(() => api.post(`/invoices/${id}/send`), "Marked as sent")}>
            Mark as Sent
          </button>
        )}
        {inv.balance > 0 && inv.status !== "void" && (
          <Link to={`/payments/new?customer=${inv.customer}&invoice=${id}`} className="btn btn-primary">
            Record Payment
          </Link>
        )}
        {inv.amountPaid === 0 && inv.status !== "void" && (
          <button className="btn btn-ghost" onClick={() => setConfirm("void")}>
            Void
          </button>
        )}
        {inv.amountPaid === 0 && (
          <button className="icon-btn" title="Delete" onClick={() => setConfirm("delete")}>
            <Icon name="trash" />
          </button>
        )}
      </PageHeader>

      {inv.payments?.length > 0 && (
        <div className="card no-print payments-panel">
          <h3>Payments Received</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payment#</th>
                <th>Mode</th>
                <th>Reference</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.payments.map((p) => (
                <tr key={p._id}>
                  <td>{date(p.date)}</td>
                  <td>
                    <Link to={`/payments/${p._id}`}>{p.paymentNumber}</Link>
                  </td>
                  <td>{modeName(p.mode)}</td>
                  <td>{p.reference}</td>
                  <td className="num">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="doc-wrap">
        <InvoiceDocument inv={inv} org={organization} />
      </div>

      <Confirm
        open={confirm === "void"}
        title="Void this invoice?"
        text="The invoice stays on record but its amount is no longer owed."
        confirmLabel="Void"
        onConfirm={() => act(() => api.post(`/invoices/${id}/void`), "Invoice voided")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        title="Delete this invoice?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/invoices/${id}`);
            toast("Invoice deleted");
            navigate("/invoices");
          } catch (e) {
            setConfirm(null);
            toast(errMsg(e), "error");
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
