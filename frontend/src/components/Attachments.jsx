import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { toast } from "./ui";
import Icon from "./Icon";

const readB64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Files attached to a transaction: upload (or take a photo on a phone), view, remove.
export default function Attachments({ docType, docId, canEdit = true }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef();
  const load = () => api.get("/attachments", { params: { docType, docId } }).then((r) => setFiles(r.data)).catch(() => setFiles([]));
  useEffect(() => {
    if (docId) load();
  }, [docType, docId]);
  const upload = async (list) => {
    setBusy(true);
    for (const f of list) {
      if (f.size > 10 * 1024 * 1024) {
        toast(`${f.name} is over 10 MB`, "error");
        continue;
      }
      try {
        await api.post("/attachments", { docType, docId, name: f.name, type: f.type, data: await readB64(f) });
      } catch (e) {
        toast(errMsg(e), "error");
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    load();
  };
  const open = async (a) => {
    const w = window.open("", "_blank");
    try {
      const r = await api.get(`/attachments/${a._id}/file`, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      if (w) w.location = url;
      else window.open(url, "_blank");
    } catch (e) {
      if (w) w.close();
      toast(errMsg(e), "error");
    }
  };
  const remove = async (a) => {
    if (!window.confirm(`Remove ${a.name}?`)) return;
    await api.delete(`/attachments/${a._id}`).catch((e) => toast(errMsg(e), "error"));
    load();
  };
  if (!docId) return null;
  return (
    <div
      className="attachments no-print"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (canEdit) upload([...e.dataTransfer.files]);
      }}
    >
      <div className="att-head">
        <span className="label-sm">Attachments {files?.length ? `(${files.length})` : ""}</span>
        {canEdit && (
          <button className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            <Icon name="plus" size={14} /> {busy ? "Uploading…" : "Attach file"}
          </button>
        )}
        <input ref={input} type="file" hidden multiple accept="application/pdf,image/*,.xlsx,.xls,.csv,.doc,.docx,.txt" onChange={(e) => upload([...e.target.files])} />
      </div>
      {files?.length ? (
        <div className="att-list">
          {files.map((a) => (
            <div key={a._id} className="att">
              <button className="att-name link-btn" onClick={() => open(a)} title="Open">
                <Icon name="clip" size={16} /> {a.name}
              </button>
              <span className="muted small">
                {size(a.size)} · {new Date(a.createdAt).toLocaleDateString("en-IN")}
                {a.uploadedBy ? ` · ${a.uploadedBy}` : ""}
              </span>
              {canEdit && (
                <button className="icon-btn" title="Remove" onClick={() => remove(a)}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">{files ? "No files yet. Attach the supplier's bill, a receipt photo or any document (up to 10 MB each)." : ""}</p>
      )}
    </div>
  );
}
