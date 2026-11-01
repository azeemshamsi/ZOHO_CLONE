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
          purchaseOrderPrefix: organization.purchaseOrderPrefix || "PO-",
          vendorCreditPrefix: organization.vendorCreditPrefix || "DN-",
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
            <Field label="Purchase Order Number Prefix">
              <input value={form.purchaseOrderPrefix} onChange={set("purchaseOrderPrefix")} />
            </Field>
            <Field label="Vendor Credit Number Prefix">
              <input value={form.vendorCreditPrefix} onChange={set("vendorCreditPrefix")} />
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
      <EmailSettings />
      <ReminderSettings />
    </>
  );
}

const PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false, help: "Use a Gmail App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password." },
  zoho: { host: "smtp.zoho.in", port: 587, secure: false, help: "Use your Zoho Mail password, or an app-specific password if 2FA is on." },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, help: "Use your Microsoft 365 / Outlook password or app password." },
  custom: { host: "", port: 587, secure: false, help: "Get the SMTP host, port and login from your email provider." },
};

function EmailSettings() {
  const { organization, setOrganization } = useAuth();
  const s = organization?.smtp || {};
  const [form, setForm] = useState({ host: s.host || "", port: s.port || 587, secure: !!s.secure, user: s.user || "", pass: "", fromName: s.fromName || organization?.name || "" });
  const [busy, setBusy] = useState(false);
  const preset = Object.entries(PRESETS).find(([k, p]) => k !== "custom" && p.host === form.host)?.[0] || (form.host ? "custom" : "gmail");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const host = form.host || PRESETS[preset].host;
      const { data } = await api.put("/organization/email", { ...form, host, port: Number(form.port) });
      setOrganization(data);
      setForm({ ...form, host, pass: "" });
      toast("Email settings saved");
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/organization/email/test");
      toast(data.message);
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const remove = async () => {
    const { data } = await api.put("/organization/email", { host: "", user: "", pass: "", fromName: "" });
    setOrganization(data);
    setForm({ host: "", port: 587, secure: false, user: "", pass: "", fromName: organization?.name || "" });
    toast("Email account removed");
  };
  return (
    <form className="card form" id="email" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Email
        <span className="muted small">{s.host && s.hasPassword ? `Sending from ${s.user}` : "Not set up — invoices can't be emailed yet"}</span>
      </h4>
      <p className="muted small">Invoices, quotes, receipts and reminders are sent from your own mailbox, so replies come straight to you.</p>
      <div className="form-grid">
        <Field label="Email Provider">
          <select value={preset} onChange={(e) => setForm({ ...form, ...PRESETS[e.target.value], host: PRESETS[e.target.value].host })}>
            <option value="gmail">Gmail / Google Workspace</option>
            <option value="zoho">Zoho Mail</option>
            <option value="outlook">Outlook / Microsoft 365</option>
            <option value="custom">Other (SMTP)</option>
          </select>
        </Field>
        <p className="muted small">{PRESETS[preset].help}</p>
        {preset === "custom" && (
          <div className="row-3">
            <Field label="SMTP Host" required>
              <input value={form.host} onChange={set("host")} placeholder="smtp.example.com" />
            </Field>
            <Field label="Port">
              <input type="number" value={form.port} onChange={set("port")} />
            </Field>
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={form.secure} onChange={set("secure")} /> SSL (port 465)
            </label>
          </div>
        )}
        <div className="row-2">
          <Field label="Email Address" required>
            <input type="email" value={form.user} onChange={set("user")} placeholder="accounts@yourbusiness.com" />
          </Field>
          <Field label={preset === "gmail" ? "App Password" : "Password"} required={!s.hasPassword} hint={s.hasPassword ? "Saved. Leave blank to keep it." : ""}>
            <input type="password" value={form.pass} onChange={set("pass")} autoComplete="new-password" />
          </Field>
        </div>
        <Field label="Sender Name" hint="Shown as the 'From' name">
          <input value={form.fromName} onChange={set("fromName")} />
        </Field>
      </div>
      <div className="form-footer">
        <button className="btn btn-primary" disabled={busy}>
          Save
        </button>
        {s.host && s.hasPassword && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={test}>
              Send Test Email
            </button>
            <button type="button" className="btn btn-ghost" onClick={remove}>
              Remove
            </button>
          </>
        )}
      </div>
    </form>
  );
}

function ReminderSettings() {
  const { organization, setOrganization } = useAuth();
  const r = organization?.reminders || { enabled: false, days: [3, 10] };
  const [enabled, setEnabled] = useState(!!r.enabled);
  const [days, setDays] = useState((r.days || []).join(", "));
  const save = async (e) => {
    e.preventDefault();
    try {
      const list = days
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      const { data } = await api.put("/organization/reminders", { enabled, days: list });
      setOrganization(data);
      setDays(data.reminders.days.join(", "));
      toast("Reminder settings saved");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  return (
    <form className="card form" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>Payment Reminders</h4>
      <div className="form-grid">
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Email customers automatically when an invoice is overdue
        </label>
        <Field label="Remind after (days past due date)" hint="e.g. 3, 10, 30 — one reminder at each step, with the invoice PDF attached. Needs email set up above and an email on the customer.">
          <input value={days} disabled={!enabled} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
      <div className="form-footer">
        <button className="btn btn-primary">Save</button>
      </div>
    </form>
  );
}
