import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { date } from "../lib/format";
import { Field, Modal, toast } from "./ui";
import Icon from "./Icon";

const split = (s) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// Download / open the server-made PDF (needs the auth header, so fetch as a blob).
export async function openPdf(kind, id, download = false) {
  try {
    const r = await api.get(`/documents/${kind}/${id}/pdf`, { responseType: "blob", params: download ? { download: 1 } : {} });
    const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
    const name = (r.headers["content-disposition"] || "").match(/filename="([^"]+)"/)?.[1] || "document.pdf";
    const a = document.createElement("a");
    a.href = url;
    if (download) a.download = name;
    else a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** "Send Email", optional "Send Reminder" and "Download PDF" buttons for a document page. */
export function DocEmail({ kind, id, onSent, reminder = false }) {
  const [open, setOpen] = useState(null); // "document" | "reminder"
  return (
    <>
      <button className="btn" onClick={() => setOpen("document")}>
        <Icon name="mail" size={16} /> Send Email
      </button>
      {reminder && (
        <button className="btn" onClick={() => setOpen("reminder")}>
          Send Reminder
        </button>
      )}
      <button className="btn" title="Download PDF" onClick={() => openPdf(kind, id, true)}>
        <Icon name="down" size={16} /> PDF
      </button>
      {open && (
        <EmailModal
          kind={kind}
          id={id}
          type={open}
          onClose={() => setOpen(null)}
          onSent={() => {
            setOpen(null);
            onSent && onSent();
          }}
        />
      )}
    </>
  );
}

function EmailModal({ kind, id, type, onClose, onSent }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/documents/${kind}/${id}/email`, { params: { type } }).then(({ data }) => {
      setD(data);
      setForm({ to: data.to.join(", "), cc: "", subject: data.subject, body: data.body, attachPdf: true });
    });
  }, [kind, id, type]);
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(`/documents/${kind}/${id}/email`, { to: split(form.to), cc: split(form.cc), subject: form.subject, body: form.body, attachPdf: form.attachPdf, type });
      toast(data.message);
      onSent();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      title={type === "reminder" ? "Send Payment Reminder" : "Send Email"}
      onClose={onClose}
      footer={
        d && (
          <>
            <button className="btn btn-primary" disabled={busy || !d.canEmail} onClick={send}>
              {busy ? "Sending…" : "Send"}
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </>
        )
      }
    >
      {!form ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="form-grid">
          {!d.canEmail && (
            <div className="alert alert-warn" style={{ marginTop: 0 }}>
              Email isn't set up yet. <Link to="/settings#email">Add your email account in Settings → Email</Link> (for Gmail, use an app password), then come back.
            </div>
          )}
          <Field label="To" required hint="Separate several addresses with commas">
            <input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="customer@example.com" />
          </Field>
          <Field label="Cc">
            <input value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} />
          </Field>
          <Field label="Subject" required>
            <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Message">
            <textarea rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.attachPdf} onChange={(e) => setForm({ ...form, attachPdf: e.target.checked })} /> Attach PDF
            <button type="button" className="link-btn" onClick={() => openPdf(kind, id)}>
              {d.fileName}
            </button>
          </label>
          {error && <div className="alert alert-error">{error}</div>}
          {d.history.length > 0 && (
            <div className="muted small">
              Sent before:{" "}
              {d.history
                .slice(0, 3)
                .map((h) => `${date(h.createdAt)} to ${h.to.join(", ")}${h.type === "reminder" ? " (reminder)" : ""}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
