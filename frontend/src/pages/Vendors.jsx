import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { STATES, GST_TREATMENTS, PAYMENT_TERMS, stateName, modeName } from "../lib/constants";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Status, Confirm } from "../components/ui";
import { AddressFields, fmtAddress } from "./Customers";
import Icon from "../components/Icon";

const emptyAddress = { street: "", city: "", state: "", pincode: "", country: "India" };

export function VendorList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/vendors", { params: { q: dq, status } }).then((r) => setRows(r.data));
  }, [dq, status]);

  return (
    <>
      <PageHeader title="Vendors">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active Vendors</option>
          <option value="inactive">Inactive Vendors</option>
          <option value="">All Vendors</option>
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Search vendors" />
        <Link to="/vendors/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="cart"
          title={q ? "No vendors match your search" : "Add your first vendor"}
          text="Vendors are the suppliers you buy goods and services from."
          action={
            <Link to="/vendors/new" className="btn btn-primary">
              New Vendor
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
                <th>Phone</th>
                <th>GSTIN</th>
                <th className="num">Payables</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v._id} onClick={() => navigate(`/vendors/${v._id}`)}>
                  <td className="strong link">{v.displayName}</td>
                  <td>{v.companyName}</td>
                  <td>{v.email}</td>
                  <td>{v.phone}</td>
                  <td className="mono">{v.gstin}</td>
                  <td className="num">{money(v.payables)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function VendorForm() {
  const [currencies, setCurrencies] = useState([]);
  useEffect(() => {
    api.get("/currencies").then((r) => setCurrencies(r.data)).catch(() => {});
  }, []);
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id) {
      api.get(`/vendors/${id}`).then(({ data }) =>
        setForm({
          displayName: data.displayName,
          companyName: data.companyName,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phone: data.phone,
          gstTreatment: data.gstTreatment,
          gstin: data.gstin,
          pan: data.pan || "",
          placeOfSupply: data.placeOfSupply,
          currency: data.currency || "INR",
          billingAddress: { ...emptyAddress, ...data.billingAddress },
          paymentTerms: data.paymentTerms,
          notes: data.notes,
          active: data.active,
        })
      );
    } else {
      setForm({
        displayName: "",
        companyName: "",
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        gstTreatment: "registered",
        gstin: "",
        pan: "",
        placeOfSupply: "",
        currency: "INR",
        billingAddress: { ...emptyAddress },
        paymentTerms: 30,
        notes: "",
        active: true,
      });
    }
  }, [id]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const suggestName = () =>
    setForm((f) => (f.displayName ? f : { ...f, displayName: f.companyName || [f.firstName, f.lastName].filter(Boolean).join(" ") }));
  const needsGstin = form.gstTreatment === "registered" || form.gstTreatment === "sez";

  // GSTIN holds the state code (first 2) and PAN (characters 3–12).
  const onGstin = (e) => {
    const gstin = e.target.value.toUpperCase();
    const next = { ...form, gstin };
    const code = gstin.slice(0, 2);
    if (STATES.some((s) => s[0] === code)) next.placeOfSupply = code;
    if (gstin.length >= 12 && !form.pan) next.pan = gstin.slice(2, 12);
    setForm(next);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...form, paymentTerms: Number(form.paymentTerms) };
      if (!needsGstin) body.gstin = "";
      const { data } = id ? await api.put(`/vendors/${id}`, body) : await api.post("/vendors", body);
      toast(id ? "Vendor updated" : "Vendor created");
      navigate(`/vendors/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? "Edit Vendor" : "New Vendor"} back={id ? `/vendors/${id}` : "/vendors"} />
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
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
          <Field label="Display Name" required>
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
            <Field label="GSTIN" required hint="The first two digits set the source of supply">
              <input required maxLength={15} value={form.gstin} onChange={onGstin} className="mono" />
            </Field>
          )}
          <div className="row-2">
            <Field label="Source of Supply" required>
              <select value={form.placeOfSupply} onChange={set("placeOfSupply")} required>
                <option value="">Select</option>
                {STATES.map(([c, n]) => (
                  <option key={c} value={c}>
                    [{c}] {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="PAN">
              <input maxLength={10} value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} className="mono" />
            </Field>
          </div>
          {currencies.length > 0 && (
            <Field label="Currency" hint="Invoices and payments for this vendor are in this currency">
              <select value={form.currency || "INR"} onChange={set("currency")}>
                <option value="INR">INR - Indian Rupee</option>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
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

        <h4 className="section-title">Address</h4>
        <div className="form-grid">
          <AddressFields value={form.billingAddress} onChange={(v) => setForm({ ...form, billingAddress: v })} />
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

export function VendorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [v, setV] = useState(null);
  const [tab, setTab] = useState("overview");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    api.get(`/vendors/${id}`).then((r) => setV(r.data));
  }, [id]);

  if (!v) return <Spinner />;

  const remove = async () => {
    try {
      await api.delete(`/vendors/${id}`);
      toast("Vendor deleted");
      navigate("/vendors");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={v.displayName} subtitle={v.companyName} back="/vendors">
        <Link to={`/vendors/${id}/edit`} className="btn">
          <Icon name="edit" size={16} /> Edit
        </Link>
        <Link to={`/purchase-orders/new?vendor=${id}`} className="btn">
          New PO
        </Link>
        <Link to={`/bills/new?vendor=${id}`} className="btn btn-primary">
          New Bill
        </Link>
        <Link to={`/payments-made/new?vendor=${id}`} className="btn">
          Record Payment
        </Link>
        <Link to={`/expenses/new?vendor=${id}`} className="btn">
          Record Expense
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
              <dd>{v.email || "—"}</dd>
              <dt>Phone</dt>
              <dd>{v.phone || "—"}</dd>
              <dt>GST Treatment</dt>
              <dd>{(GST_TREATMENTS.find((g) => g[0] === v.gstTreatment) || [])[1]}</dd>
              <dt>GSTIN</dt>
              <dd className="mono">{v.gstin || "—"}</dd>
              <dt>PAN</dt>
              <dd className="mono">{v.pan || "—"}</dd>
              <dt>Source of Supply</dt>
              <dd>{stateName(v.placeOfSupply) || "—"}</dd>
              <dt>Payment Terms</dt>
              <dd>{(PAYMENT_TERMS.find((p) => p[0] === v.paymentTerms) || [0, `Net ${v.paymentTerms}`])[1]}</dd>
            </dl>
            <h4 className="section-title">Address</h4>
            <address>{fmtAddress(v.billingAddress).map((l) => <div key={l}>{l}</div>)}</address>
          </div>
          <div className="card stat-row">
            <div>
              <span className="muted small">Outstanding Payables</span>
              <strong className="big">{money(v.payables)}</strong>
            </div>
            <div>
              <span className="muted small">Advances & Vendor Credits</span>
              <strong className="big">{money(v.unusedCredits)}</strong>
            </div>
          </div>
        </div>
      ) : (
        <div className="stack">
          {[
            {
              title: "Bills",
              rows: v.bills,
              to: (b) => `/bills/${b._id}`,
              cols: [
                ["Date", (b) => date(b.date)],
                ["Bill#", (b) => b.billNumber, "link"],
                ["Status", (b) => <Status value={b.displayStatus} />],
                ["Amount", (b) => money(b.total, b.currency), "num"],
                ["Balance Due", (b) => money(b.balance, b.currency), "num"],
              ],
            },
            {
              title: "Vendor Credits",
              rows: v.vendorCredits || [],
              to: (c) => `/vendor-credits/${c._id}`,
              cols: [
                ["Date", (c) => date(c.date)],
                ["Vendor Credit#", (c) => c.number, "link"],
                ["Status", (c) => <Status value={c.status} />],
                ["Amount", (c) => money(c.total, c.currency), "num"],
                ["Balance", (c) => money(c.balance, c.currency), "num"],
              ],
            },
            {
              title: "Payments Made",
              rows: v.payments,
              to: (p) => `/payments-made/${p._id}`,
              cols: [
                ["Date", (p) => date(p.date)],
                ["Payment#", (p) => p.paymentNumber, "link"],
                ["Mode", (p) => modeName(p.mode)],
                ["Amount", (p) => money(p.amount, p.currency), "num"],
              ],
            },
            {
              title: "Expenses",
              rows: v.expenses,
              to: (e) => `/expenses/${e._id}/edit`,
              cols: [
                ["Date", (e) => date(e.date)],
                ["Expense Account", (e) => e.category, "link"],
                ["Paid Through", (e) => modeName(e.paidThrough)],
                ["Amount", (e) => money(e.total), "num"],
              ],
            },
          ].map((t) => (
            <div className="card flush" key={t.title}>
              <h3 className="card-title">{t.title}</h3>
              <table className="table table-click">
                <thead>
                  <tr>
                    {t.cols.map(([l, , c]) => (
                      <th key={l} className={c === "num" ? "num" : ""}>
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r) => (
                    <tr key={r._id} onClick={() => navigate(t.to(r))}>
                      {t.cols.map(([l, f, c]) => (
                        <td key={l} className={c || ""}>
                          {f(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {!t.rows.length && (
                    <tr>
                      <td colSpan={t.cols.length} className="muted center">
                        None yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      <Confirm
        open={confirm}
        title="Delete vendor?"
        text="This can't be undone. Vendors with transactions can only be marked inactive."
        onConfirm={remove}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
