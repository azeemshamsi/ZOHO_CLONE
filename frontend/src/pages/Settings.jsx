import { useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES, PAYMENT_TERMS } from "../lib/constants";
import { PageHeader, Field, toast, Spinner } from "../components/ui";

export default function Settings() {
  const { organization, setOrganization } = useAuth();
  const [form, setForm] = useState(() =>
    organization
      ? {
          name: organization.name || "",
          gstin: organization.gstin || "",
          state: organization.state || "",
          address: { street: "", city: "", state: "", pincode: "", country: "India", ...organization.address },
          email: organization.email || "",
          phone: organization.phone || "",
          website: organization.website || "",
          invoicePrefix: organization.invoicePrefix || "INV-",
          paymentPrefix: organization.paymentPrefix || "PAY-",
          quotePrefix: organization.quotePrefix || "QT-",
          salesOrderPrefix: organization.salesOrderPrefix || "SO-",
          creditNotePrefix: organization.creditNotePrefix || "CN-",
          vendorPaymentPrefix: organization.vendorPaymentPrefix || "PM-",
          journalPrefix: organization.journalPrefix || "MJ-",
          defaultPaymentTerms: organization.defaultPaymentTerms ?? 15,
          defaultNotes: organization.defaultNotes || "",
          defaultTerms: organization.defaultTerms || "",
        }
      : null
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setA = (k) => (e) => setForm({ ...form, address: { ...form.address, [k]: e.target.value } });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.put("/organization", {
        ...form,
        address: { ...form.address, state: form.state },
        defaultPaymentTerms: Number(form.defaultPaymentTerms),
      });
      setOrganization(data);
      toast("Settings saved");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Organization Profile" subtitle="These details appear on your invoices and receipts." />
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Organization Name" required>
            <input required value={form.name} onChange={set("name")} />
          </Field>
          <div className="row-2">
            <Field label="GSTIN" hint="Leave blank if you're not GST-registered">
              <input className="mono" maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Business Location (State)" required>
              <select required value={form.state} onChange={set("state")}>
                {STATES.map(([c, n]) => (
                  <option key={c} value={c}>
                    [{c}] {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Street Address">
            <textarea rows={2} value={form.address.street} onChange={setA("street")} />
          </Field>
          <div className="row-2">
            <Field label="City">
              <input value={form.address.city} onChange={setA("city")} />
            </Field>
            <Field label="PIN Code">
              <input value={form.address.pincode} onChange={setA("pincode")} />
            </Field>
          </div>
          <div className="row-3">
            <Field label="Email">
              <input type="email" value={form.email} onChange={set("email")} />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={set("phone")} />
            </Field>
            <Field label="Website">
              <input value={form.website} onChange={set("website")} />
            </Field>
          </div>
        </div>

        <h4 className="section-title">Numbering & Defaults</h4>
        <div className="form-grid">
          <div className="row-3">
            <Field label="Invoice Number Prefix">
              <input value={form.invoicePrefix} onChange={set("invoicePrefix")} />
            </Field>
            <Field label="Payment Number Prefix">
              <input value={form.paymentPrefix} onChange={set("paymentPrefix")} />
            </Field>
            <Field label="Quote Number Prefix">
              <input value={form.quotePrefix} onChange={set("quotePrefix")} />
            </Field>
          </div>
          <div className="row-3">
            <Field label="Sales Order Number Prefix">
              <input value={form.salesOrderPrefix} onChange={set("salesOrderPrefix")} />
            </Field>
            <Field label="Credit Note Number Prefix">
              <input value={form.creditNotePrefix} onChange={set("creditNotePrefix")} />
            </Field>
            <Field label="Payment Made Number Prefix">
              <input value={form.vendorPaymentPrefix} onChange={set("vendorPaymentPrefix")} />
            </Field>
          </div>
          <div className="row-3">
            <Field label="Journal Number Prefix">
              <input value={form.journalPrefix} onChange={set("journalPrefix")} />
            </Field>
            <Field label="Default Payment Terms">
              <select value={form.defaultPaymentTerms} onChange={set("defaultPaymentTerms")}>
                {PAYMENT_TERMS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Default Customer Notes">
            <textarea rows={2} value={form.defaultNotes} onChange={set("defaultNotes")} />
          </Field>
          <Field label="Default Terms & Conditions">
            <textarea rows={3} value={form.defaultTerms} onChange={set("defaultTerms")} />
          </Field>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </>
  );
}
