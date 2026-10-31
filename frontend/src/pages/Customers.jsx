import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES, GST_TREATMENTS, PAYMENT_TERMS, stateName, modeName } from "../lib/constants";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Status, invoiceStatus, Confirm } from "../components/ui";
import Icon from "../components/Icon";

export function CustomerList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/customers", { params: { q: dq, status } }).then((r) => setRows(r.data));
  }, [dq, status]);

  return (
    <>
      <PageHeader title="Customers">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active Customers</option>
          <option value="inactive">Inactive Customers</option>
          <option value="">All Customers</option>
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Search customers" />
        <Link to="/customers/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="users"
          title={q ? "No customers match your search" : "Add your first customer"}
          text="Customers are the people and businesses you sell to."
          action={
            <Link to="/customers/new" className="btn btn-primary">
              New Customer
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Name</th>
                <th>Company Name</th>
                <th>Email</th>
                <th>Work Phone</th>
                <th>GST Treatment</th>
                <th className="num">Receivables</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c._id} onClick={() => navigate(`/customers/${c._id}`)}>
                  <td className="strong link">{c.displayName}</td>
                  <td>{c.companyName}</td>
                  <td>{c.email}</td>
                  <td>{c.phone}</td>
                  <td>{(GST_TREATMENTS.find((g) => g[0] === c.gstTreatment) || [])[1]}</td>
                  <td className="num">{money(c.receivables)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const emptyAddress = { street: "", city: "", state: "", pincode: "", country: "India" };

export function AddressFields({ value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="stack">
      <Field label="Street">
        <textarea rows={2} value={value.street} onChange={set("street")} />
      </Field>
      <div className="row-2">
        <Field label="City">
          <input value={value.city} onChange={set("city")} />
        </Field>
        <Field label="State">
          <select value={value.state} onChange={set("state")}>
            <option value="">Select</option>
            {STATES.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row-2">
        <Field label="PIN Code">
          <input value={value.pincode} onChange={set("pincode")} />
        </Field>
        <Field label="Country">
          <input value={value.country} onChange={set("country")} />
        </Field>
      </div>
    </div>
  );
}

export function CustomerForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id) {
      api.get(`/customers/${id}`).then(({ data }) =>
        setForm({
          customerType: data.customerType,
          displayName: data.displayName,
          companyName: data.companyName,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phone: data.phone,
          gstTreatment: data.gstTreatment,
          gstin: data.gstin,
          placeOfSupply: data.placeOfSupply,
          billingAddress: { ...emptyAddress, ...data.billingAddress },
          shippingAddress: { ...emptyAddress, ...data.shippingAddress },
          paymentTerms: data.paymentTerms,
          notes: data.notes,
          active: data.active,
        })
      );
    } else {
      setForm({
        customerType: "business",
        displayName: "",
        companyName: "",
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        gstTreatment: "consumer",
        gstin: "",
        placeOfSupply: organization?.state || "",
        billingAddress: { ...emptyAddress },
        shippingAddress: { ...emptyAddress },
        paymentTerms: organization?.defaultPaymentTerms ?? 15,
        notes: "",
        active: true,
      });
    }
  }, [id, organization]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const suggestName = () =>
    setForm((f) =>
      f.displayName ? f : { ...f, displayName: f.companyName || [f.firstName, f.lastName].filter(Boolean).join(" ") }
    );
  const needsGstin = form.gstTreatment === "registered" || form.gstTreatment === "sez";

  const onGstin = (e) => {
    const gstin = e.target.value.toUpperCase();
    const code = gstin.slice(0, 2);
    const next = { ...form, gstin };
    if (STATES.some((s) => s[0] === code)) next.placeOfSupply = code;
    setForm(next);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...form, paymentTerms: Number(form.paymentTerms) };
      if (!needsGstin) body.gstin = "";
      const { data } = id ? await api.put(`/customers/${id}`, body) : await api.post("/customers", body);
      toast(id ? "Customer updated" : "Customer created");
      navigate(`/customers/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? "Edit Customer" : "New Customer"} back={id ? `/customers/${id}` : "/customers"} />
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Customer Type">
            <div className="radio-row">
              {["business", "individual"].map((t) => (
                <label key={t} className="radio">
                  <input type="radio" checked={form.customerType === t} onChange={() => setForm({ ...form, customerType: t })} />
                  {t === "business" ? "Business" : "Individual"}
                </label>
              ))}
            </div>
          </Field>
          <div className="row-2">
            <Field label="First Name">
              <input value={form.firstName} onChange={set("firstName")} onBlur={suggestName} />
            </Field>
            <Field label="Last Name">
              <input value={form.lastName} onChange={set("lastName")} onBlur={suggestName} />
            </Field>
          </div>
          <Field label="Company Name">
            <input value={form.companyName} onChange={set("companyName")} onBlur={suggestName} />
          </Field>
          <Field label="Display Name" required hint="Shown on invoices">
            <input required value={form.displayName} onChange={set("displayName")} />
          </Field>
          <div className="row-2">
            <Field label="Email">
              <input type="email" value={form.email} onChange={set("email")} />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={set("phone")} />
            </Field>
          </div>
        </div>

        <h4 className="section-title">GST & Payment</h4>
        <div className="form-grid">
          <Field label="GST Treatment" required>
            <select value={form.gstTreatment} onChange={set("gstTreatment")}>
              {GST_TREATMENTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {needsGstin && (
            <Field label="GSTIN" required hint="15 characters; the first two digits set the place of supply">
              <input required maxLength={15} value={form.gstin} onChange={onGstin} className="mono" />
            </Field>
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
          <Field label="Payment Terms">
            <select value={form.paymentTerms} onChange={set("paymentTerms")}>
              {PAYMENT_TERMS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid-2 address-grid">
          <div>
            <h4 className="section-title">Billing Address</h4>
            <AddressFields value={form.billingAddress} onChange={(v) => setForm({ ...form, billingAddress: v })} />
          </div>
          <div>
            <h4 className="section-title">
              Shipping Address
              <button type="button" className="link-btn" onClick={() => setForm({ ...form, shippingAddress: { ...form.billingAddress } })}>
                Copy billing address
              </button>
            </h4>
            <AddressFields value={form.shippingAddress} onChange={(v) => setForm({ ...form, shippingAddress: v })} />
          </div>
        </div>

        <h4 className="section-title">Other</h4>
        <div className="form-grid">
          <Field label="Notes">
            <textarea rows={3} value={form.notes} onChange={set("notes")} />
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
          <button type="button" className="btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

export function fmtAddress(a = {}) {
  return [a.street, a.city, [stateName(a.state), a.pincode].filter(Boolean).join(" "), a.country].filter(Boolean);
}

export function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState("overview");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    api.get(`/customers/${id}`).then((r) => setC(r.data));
  }, [id]);

  if (!c) return <Spinner />;

  const remove = async () => {
    try {
      await api.delete(`/customers/${id}`);
      toast("Customer deleted");
      navigate("/customers");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={c.displayName} subtitle={c.companyName} back="/customers">
        <Link to={`/customers/${id}/edit`} className="btn">
          <Icon name="edit" size={16} /> Edit
        </Link>
        <Link to={`/quotes/new?customer=${id}`} className="btn">
          New Quote
        </Link>
        <Link to={`/invoices/new?customer=${id}`} className="btn btn-primary">
          New Invoice
        </Link>
        <Link to={`/payments/new?customer=${id}`} className="btn">
          Record Payment
        </Link>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>

      <div className="tabs">
        {["overview", "transactions"].map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : "Transactions"}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid-side">
          <div className="card">
            <dl className="details">
              <dt>Email</dt>
              <dd>{c.email || "—"}</dd>
              <dt>Phone</dt>
              <dd>{c.phone || "—"}</dd>
              <dt>GST Treatment</dt>
              <dd>{(GST_TREATMENTS.find((g) => g[0] === c.gstTreatment) || [])[1]}</dd>
              <dt>GSTIN</dt>
              <dd className="mono">{c.gstin || "—"}</dd>
              <dt>Place of Supply</dt>
              <dd>{stateName(c.placeOfSupply) || "—"}</dd>
              <dt>Payment Terms</dt>
              <dd>{(PAYMENT_TERMS.find((p) => p[0] === c.paymentTerms) || [0, `Net ${c.paymentTerms}`])[1]}</dd>
            </dl>
            <h4 className="section-title">Billing Address</h4>
            <address>{fmtAddress(c.billingAddress).map((l) => <div key={l}>{l}</div>)}</address>
            {c.notes && (
              <>
                <h4 className="section-title">Notes</h4>
                <p>{c.notes}</p>
              </>
            )}
          </div>
          <div className="stack">
            <div className="card stat-row">
              <div>
                <span className="muted small">Outstanding Receivables</span>
                <strong className="big">{money(c.receivables)}</strong>
              </div>
              <div>
                <span className="muted small">Unused Credits</span>
                <strong className="big">{money(c.unusedCredits)}</strong>
              </div>
            </div>
            <div className="card">
              <h3>Recent activity</h3>
              <ul className="timeline">
                {[...c.invoices.map((i) => ({ d: i.date, t: `Invoice ${i.invoiceNumber} for ${money(i.total)}`, to: `/invoices/${i._id}` })),
                  ...c.payments.map((p) => ({ d: p.date, t: `Payment ${p.paymentNumber} of ${money(p.amount)} received`, to: `/payments/${p._id}` }))]
                  .sort((a, b) => new Date(b.d) - new Date(a.d))
                  .slice(0, 8)
                  .map((x, i) => (
                    <li key={i}>
                      <span className="muted small">{date(x.d)}</span>
                      <Link to={x.to}>{x.t}</Link>
                    </li>
                  ))}
                {c.invoices.length + c.payments.length === 0 && <li className="muted">No transactions yet.</li>}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="card flush">
            <h3 className="card-title">Invoices</h3>
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Invoice#</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th className="num">Balance Due</th>
                </tr>
              </thead>
              <tbody>
                {c.invoices.map((i) => (
                  <tr key={i._id} onClick={() => navigate(`/invoices/${i._id}`)}>
                    <td>{date(i.date)}</td>
                    <td className="link">{i.invoiceNumber}</td>
                    <td>
                      <Status value={invoiceStatus(i.displayStatus)} />
                    </td>
                    <td className="num">{money(i.total)}</td>
                    <td className="num">{money(i.balance)}</td>
                  </tr>
                ))}
                {!c.invoices.length && (
                  <tr>
                    <td colSpan={5} className="muted center">
                      No invoices
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {c.creditNotes?.length > 0 && (
            <div className="card flush">
              <h3 className="card-title">Credit Notes</h3>
              <table className="table table-click">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Credit Note#</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {c.creditNotes.map((n) => (
                    <tr key={n._id} onClick={() => navigate(`/credit-notes/${n._id}`)}>
                      <td>{date(n.date)}</td>
                      <td className="link">{n.number}</td>
                      <td>
                        <Status value={n.status} />
                      </td>
                      <td className="num">{money(n.total)}</td>
                      <td className="num">{money(n.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card flush">
            <h3 className="card-title">Payments Received</h3>
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Payment#</th>
                  <th>Mode</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {c.payments.map((p) => (
                  <tr key={p._id} onClick={() => navigate(`/payments/${p._id}`)}>
                    <td>{date(p.date)}</td>
                    <td className="link">{p.paymentNumber}</td>
                    <td>{modeName(p.mode)}</td>
                    <td className="num">{money(p.amount)}</td>
                  </tr>
                ))}
                {!c.payments.length && (
                  <tr>
                    <td colSpan={4} className="muted center">
                      No payments
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <Confirm
        open={confirm}
        title="Delete customer?"
        text="This can't be undone. Customers with invoices can only be marked inactive."
        onConfirm={remove}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
