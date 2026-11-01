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
      <AiSettings />
      <ReminderSettings />
    </>
  );
}

const PRESETS = {
  brevo: { api: true, help: "Recommended on Render's free plan, which blocks normal (SMTP) email. Free Brevo account (300 emails/day): add your email under Senders and verify it, then create an API key under SMTP & API → API Keys." },
  resend: { api: true, help: "Works on Render's free plan. Verify your domain (e.g. ordexago.com) in Resend → Domains, create an API key, and send from an address on that domain." },
  gmail: { host: "smtp.gmail.com", port: 587, secure: false, help: "Use a Gmail App Password (Google Account → Security → 2-Step Verification → App passwords). Needs SMTP, which Render's free plan blocks." },
  zoho: { host: "smtp.zoho.in", port: 587, secure: false, help: "Use your Zoho Mail password, or an app-specific password if 2FA is on. Needs SMTP, which Render's free plan blocks." },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, help: "Use your Microsoft 365 / Outlook password or app password. Needs SMTP, which Render's free plan blocks." },
  custom: { host: "", port: 587, secure: false, help: "Get the SMTP host, port and login from your email provider. Needs SMTP, which Render's free plan blocks." },
};

function EmailSettings() {
  const { organization, setOrganization } = useAuth();
  const s = organization?.smtp || {};
  const savedPreset = s.provider && s.provider !== "smtp" ? s.provider : Object.entries(PRESETS).find(([k, p]) => !p.api && k !== "custom" && p.host === s.host)?.[0] || (s.host ? "custom" : "brevo");
  const [preset, setPreset] = useState(savedPreset);
  const [form, setForm] = useState({ host: s.host || "", port: s.port || 587, secure: !!s.secure, user: s.user || "", pass: "", apiKey: "", fromName: s.fromName || organization?.name || "" });
  const [busy, setBusy] = useState(false);
  const isApi = !!PRESETS[preset].api;
  const configured = s.user && (s.provider && s.provider !== "smtp" ? s.hasApiKey : s.host && s.hasPassword);
  const keySaved = s.hasApiKey && s.provider === preset;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const choose = (p) => {
    setPreset(p);
    if (!PRESETS[p].api) setForm({ ...form, host: PRESETS[p].host, port: PRESETS[p].port, secure: PRESETS[p].secure });
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = isApi ? { provider: preset, user: form.user, apiKey: form.apiKey, fromName: form.fromName } : { provider: "smtp", ...form, apiKey: "", host: form.host || PRESETS[preset].host, port: Number(form.port) };
      const { data } = await api.put("/organization/email", body);
      setOrganization(data);
      setForm({ ...form, host: body.host || "", pass: "", apiKey: "" });
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
    const { data } = await api.put("/organization/email", { provider: "smtp", host: "", user: "", pass: "", apiKey: "", fromName: "" });
    setOrganization(data);
    setForm({ host: "", port: 587, secure: false, user: "", pass: "", apiKey: "", fromName: organization?.name || "" });
    toast("Email account removed");
  };
  return (
    <form className="card form" id="email" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Email
        <span className="muted small">{configured ? `Sending from ${s.user}${s.provider && s.provider !== "smtp" ? ` via ${s.provider === "brevo" ? "Brevo" : "Resend"}` : ""}` : "Not set up — invoices can't be emailed yet"}</span>
      </h4>
      <p className="muted small">Invoices, quotes, receipts and reminders are sent from this address. Replies go to your organization's email.</p>
      <div className="form-grid">
        <Field label="Send Using">
          <select value={preset} onChange={(e) => choose(e.target.value)}>
            <option value="brevo">Brevo (HTTPS API) — works on Render free</option>
            <option value="resend">Resend (HTTPS API) — works on Render free</option>
            <option value="gmail">Gmail / Google Workspace (SMTP)</option>
            <option value="zoho">Zoho Mail (SMTP)</option>
            <option value="outlook">Outlook / Microsoft 365 (SMTP)</option>
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
          <Field label={isApi ? "Sender Email" : "Email Address"} required hint={preset === "brevo" ? "Must be a verified sender in Brevo" : preset === "resend" ? "Must be on a domain verified in Resend" : ""}>
            <input type="email" value={form.user} onChange={set("user")} placeholder="accounts@yourbusiness.com" />
          </Field>
          {isApi ? (
            <Field label="API Key" required={!keySaved} hint={keySaved ? "Saved. Leave blank to keep it." : ""}>
              <input type="password" value={form.apiKey} onChange={set("apiKey")} autoComplete="new-password" placeholder={preset === "brevo" ? "xkeysib-…" : "re_…"} />
            </Field>
          ) : (
            <Field label={preset === "gmail" ? "App Password" : "Password"} required={!s.hasPassword} hint={s.hasPassword ? "Saved. Leave blank to keep it." : ""}>
              <input type="password" value={form.pass} onChange={set("pass")} autoComplete="new-password" />
            </Field>
          )}
        </div>
        <Field label="Sender Name" hint="Shown as the 'From' name">
          <input value={form.fromName} onChange={set("fromName")} />
        </Field>
      </div>
      <div className="form-footer">
        <button className="btn btn-primary" disabled={busy}>
          Save
        </button>
        {configured && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={test}>
              {busy ? "Sending…" : "Send Test Email"}
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

function AiSettings() {
  const { organization, setOrganization } = useAuth();
  const ai = organization?.ai || {};
  const [key, setKey] = useState("");
  const [model, setModel] = useState(ai.model || "");
  const [busy, setBusy] = useState(false);
  const save = async (e, remove = false) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.put("/organization/ai", { geminiKey: key, model, remove });
      const { warning, ...org } = data;
      setOrganization(org);
      setKey("");
      if (warning) toast(warning, "error");
      else toast(remove ? "Gemini key removed" : `Gemini connected${org.ai?.resolvedModel ? ` (${org.ai.resolvedModel})` : ""} — scanned bills and photos will now be read automatically`);
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const test = async () => {
    try {
      const { data } = await api.post("/organization/ai/test");
      toast(data.message);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  return (
    <form className="card form" id="integrations" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Integrations · Google Gemini
        <span className="muted small">{ai.hasGeminiKey ? `Connected${ai.model || ai.resolvedModel ? ` · ${ai.model || ai.resolvedModel}` : ""}` : "Not connected"}</span>
      </h4>
      <p className="muted small">
        Reads scanned bills and phone photos in “From bill PDF”. Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> (sign in with your
        Google account → Create API key). A Gemini app subscription (Pro/Advanced) doesn't include API access by itself; the API key is separate and has a free allowance.
      </p>
      <div className="form-grid">
        <div className="row-2">
          <Field label="Gemini API key" hint={ai.hasGeminiKey ? "Saved. Leave blank to keep it." : ""}>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" placeholder={ai.hasGeminiKey ? "••••••••••••" : "AIza…"} />
          </Field>
          <Field label="Model" hint="Leave blank for the latest Flash model">
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-flash-latest" />
          </Field>
        </div>
      </div>
      <div className="form-footer">
        <button className="btn btn-primary" disabled={busy || (!key && !ai.hasGeminiKey)}>
          {busy ? "Checking…" : "Save"}
        </button>
        {ai.hasGeminiKey && (
          <>
            <button type="button" className="btn" onClick={test}>
              Test
            </button>
            <button type="button" className="btn" onClick={(e) => save(e, true)}>
              Remove
            </button>
          </>
        )}
      </div>
    </form>
  );
}
