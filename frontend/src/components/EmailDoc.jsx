import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { date } from "../lib/format";
import { Field, Modal, MoreMenu, toast } from "./ui";
import Icon from "./Icon";

const split = (s) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// Print the same PDF that downloads (not the on-screen page): loaded in a hidden frame, then the print dialog.
// Receipt / label printer: an HTML page exactly the roll's width and the content's length, printed at 100%.
async function printRoll(kind, id, width) {
  const { data } = await api.get(`/documents/${kind}/${id}/receipt`, { params: { width } });
  const f = document.createElement("iframe");
  f.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}in;height:10px;border:0`;
  document.body.appendChild(f);
  const w = f.contentWindow;
  w.document.open();
  w.document.write(data.html);
  w.document.close();
  const go = () => {
    // Page length = the content's length (in mm), so nothing is cut or shrunk.
    const mm = Math.ceil((w.document.documentElement.scrollHeight * 25.4) / 96) + 4;
    const st = w.document.createElement("style");
    st.textContent = `@page { size: ${width}in ${mm}mm; margin: 0; }`;
    w.document.head.appendChild(st);
    w.focus();
    w.print();
    setTimeout(() => f.remove(), 60000);
  };
  const imgs = [...w.document.images];
  if (imgs.some((i) => !i.complete)) Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r))))).then(go);
  else setTimeout(go, 50);
}

export async function printPdf(kind, id, thermal) {
  if (thermal)
    return printRoll(kind, id, thermal).catch((e) => toast(errMsg(e), "error"));
  try {
    const r = await api.get(`/documents/${kind}/${id}/pdf`, { responseType: "blob", params: thermal ? { thermal } : {} });
    const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    f.src = url;
    f.onload = () => {
      try {
        f.contentWindow.focus();
        f.contentWindow.print();
      } catch {
        window.open(url, "_blank"); // browsers that block printing a frame: open the PDF to print from there
      }
      setTimeout(() => {
        f.remove();
        URL.revokeObjectURL(url);
      }, 120000);
    };
    document.body.appendChild(f);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// Print: A4, or roll paper for a direct thermal / receipt printer (2" or 3" wide).
export function PrintMenu({ kind, id }) {
  return (
    <MoreMenu
      label={
        <>
          <Icon name="print" size={16} /> Print
        </>
      }
      items={[
        { label: "A4 (full page)", onClick: () => printPdf(kind, id) },
        { label: "Receipt printer — 3 inch (80 mm)", onClick: () => printPdf(kind, id, 3) },
        { label: "Receipt printer — 2 inch (58 mm)", onClick: () => printPdf(kind, id, 2) },
      ]}
    />
  );
}

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
