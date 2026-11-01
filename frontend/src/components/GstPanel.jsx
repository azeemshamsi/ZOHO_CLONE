import { useEffect, useState } from "react";
import QRCode from "qrcode";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, isoDate } from "../lib/format";
import { STATES } from "../lib/constants";
import { Field, Modal, toast } from "./ui";

export function downloadJson(obj, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function QrImage({ text, size = 110 }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (text) QRCode.toDataURL(text, { margin: 1, width: size * 2, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [text, size]);
  return src ? <img src={src} width={size} height={size} alt="e-invoice QR code" /> : null;
}

const MODES = [
  ["1", "Road"],
  ["2", "Rail"],
  ["3", "Air"],
  ["4", "Ship"],
];

/** E-invoice (invoices and credit notes) and e-way bill (invoices) panel for a document page. */
export function GstPanel({ kind, doc, onChanged, eligible }) {
  const { organization } = useAuth();
  const [modal, setModal] = useState(null);
  const e = doc.einvoice || {};
  const w = doc.eway || {};
  const einvOn = organization?.einvoicing?.enabled && eligible;
  const goods = (doc.lineItems || []).some((l) => !String(l.hsnSac || "").startsWith("99"));
  const ewayOn = kind === "invoice" && organization?.ewayBills?.enabled && goods && doc.status !== "draft";
  if (!einvOn && !ewayOn && e.status !== "generated" && w.status !== "generated") return null;
  if (doc.status === "void" && e.status !== "generated") return null;

  const getJson = async () => {
    try {
      const { data } = await api.get(`/gst/einvoice/${kind}/${doc._id}/json`);
      if (data.errors.length) return setModal({ type: "errors", title: "Fix these before uploading", errors: data.errors });
      downloadJson([data.json], `einvoice-${doc.invoiceNumber || doc.number}.json`);
      toast("JSON downloaded — upload it on einvoice1.gst.gov.in (Bulk Upload)");
    } catch (x) {
      toast(errMsg(x), "error");
    }
  };
  const getEway = async () => {
    try {
      const { data } = await api.post("/gst/eway/bulk-json", { ids: [doc._id] });
      if (data.skipped.length) return setModal({ type: "errors", title: "Fix these before uploading", errors: data.skipped[0].errors });
      downloadJson(data.json, `ewaybill-${doc.invoiceNumber}.json`);
      toast("JSON downloaded — upload it on ewaybillgst.gov.in (Generate Bulk)");
    } catch (x) {
      toast(errMsg(x), "error");
    }
  };
  const run = async (fn, msg) => {
    try {
      const r = await fn();
      toast(msg);
      if (r?.data?.warning) toast(r.data.warning, "error");
      onChanged();
    } catch (x) {
      toast(errMsg(x), "error");
    }
  };
  return (
    <div className="card gst-panel no-print">
      {(einvOn || e.status === "generated" || e.status === "cancelled") && (
        <div className="gst-row">
          <div className="gst-main">
            <div className="gst-title">
              e-Invoice{" "}
              <span className={`status status-${e.status === "generated" ? "paid" : e.status === "cancelled" ? "void" : "draft"}`}>
                {e.status === "generated" ? "IRN Generated" : e.status === "cancelled" ? "Cancelled" : "Not generated"}
              </span>
            </div>
            {e.status === "generated" || e.status === "cancelled" ? (
              <div className="small gst-meta">
                <div>
                  IRN <span className="mono">{e.irn}</span>
                </div>
                <div>
                  Ack No {e.ackNo} · {e.ackDate && new Date(e.ackDate).toLocaleString("en-IN")}
                  {e.status === "cancelled" && ` · cancelled (${e.cancelReason})`}
                </div>
              </div>
            ) : (
              <div className="muted small">Download the JSON, upload it on the e-invoice portal, then record the IRN it returns.</div>
            )}
          </div>
          <div className="gst-actions">
            {e.status !== "generated" && doc.status !== "draft" && (
              <>
                <button className="btn btn-sm" onClick={getJson}>
                  Download JSON
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "irn" })}>
                  Record IRN
                </button>
              </>
            )}
            {e.status === "generated" && (
              <>
                {e.signedQr && <QrImage text={e.signedQr} size={72} />}
                <button className="btn btn-sm" onClick={() => setModal({ type: "cancel" })}>
                  Cancel e-Invoice
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {(ewayOn || w.status === "generated") && (
        <div className="gst-row">
          <div className="gst-main">
            <div className="gst-title">
              e-Way Bill{" "}
              <span className={`status status-${w.status === "generated" ? "paid" : w.status === "cancelled" ? "void" : "draft"}`}>
                {w.status === "generated" ? "Generated" : w.status === "cancelled" ? "Cancelled" : "Not generated"}
              </span>
            </div>
            <div className="small gst-meta">
              {w.status === "generated" ? (
                <>
                  EWB No <b>{w.ewbNo}</b> · {date(w.ewbDate)}
                  {w.validUpto && ` · valid till ${date(w.validUpto)}`}
                </>
              ) : w.distance ? (
                <>
                  {MODES.find((m) => m[0] === w.transMode)?.[1]} · {w.distance} km {w.vehicleNo && `· ${w.vehicleNo}`} {w.transporterName && `· ${w.transporterName}`}
                </>
              ) : (
                <span className="muted">{Number(doc.total) * (doc.exchangeRate || 1) >= (organization?.ewayBills?.threshold ?? 50000) ? "Required: consignment value is ₹50,000 or more." : "Optional for this value."} Add transport details to create the JSON.</span>
              )}
            </div>
          </div>
          <div className="gst-actions">
            {w.status !== "generated" ? (
              <>
                <button className="btn btn-sm" onClick={() => setModal({ type: "transport" })}>
                  Transport Details
                </button>
                {w.distance > 0 && (
                  <>
                    <button className="btn btn-sm" onClick={getEway}>
                      Download JSON
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "ewb" })}>
                      Record EWB No
                    </button>
                  </>
                )}
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => run(() => api.post(`/gst/eway/${doc._id}/cancel`), "E-way bill marked cancelled")}>
                Mark Cancelled
              </button>
            )}
          </div>
        </div>
      )}
      {modal?.type === "errors" && (
        <Modal open title={modal.title} onClose={() => setModal(null)} footer={<button className="btn btn-primary" onClick={() => setModal(null)}>OK</button>}>
          <ul className="err-list">
            {modal.errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Modal>
      )}
      {modal?.type === "irn" && <IrnModal kind={kind} doc={doc} onClose={() => setModal(null)} onSaved={() => (setModal(null), onChanged())} />}
      {modal?.type === "cancel" && <CancelModal kind={kind} doc={doc} onClose={() => setModal(null)} onSaved={() => (setModal(null), onChanged())} />}
      {modal?.type === "transport" && <TransportModal doc={doc} onClose={() => setModal(null)} onSaved={() => (setModal(null), onChanged())} />}
      {modal?.type === "ewb" && <EwbModal doc={doc} onClose={() => setModal(null)} onSaved={() => (setModal(null), onChanged())} />}
    </div>
  );
}

function IrnModal({ kind, doc, onClose, onSaved }) {
  const [f, setF] = useState({ irn: "", ackNo: "", ackDate: "", signedQr: "" });
  const [error, setError] = useState("");
  // Fill from the IRP's response file (Irn, AckNo, AckDt, SignedQRCode).
  const readFile = async (file) => {
    try {
      let j = JSON.parse(await file.text());
      if (Array.isArray(j)) j = j[0];
      j = j.Data ? (typeof j.Data === "string" ? JSON.parse(j.Data) : j.Data) : j;
      const ack = j.AckDt || j.AckDate || "";
      setF({ irn: j.Irn || j.irn || "", ackNo: String(j.AckNo || j.ackNo || ""), ackDate: ack ? ack.replace(" ", "T").slice(0, 16) : "", signedQr: j.SignedQRCode || j.signedQr || "" });
    } catch {
      setError("That file isn't an e-invoice response JSON");
    }
  };
  const save = async () => {
    try {
      await api.post(`/gst/einvoice/${kind}/${doc._id}/irn`, f);
      toast("IRN recorded");
      onSaved();
    } catch (x) {
      setError(errMsg(x));
    }
  };
  return (
    <Modal open wide title="Record e-Invoice (IRN)" onClose={onClose} footer={<><button className="btn btn-primary" onClick={save}>Save</button><button className="btn" onClick={onClose}>Cancel</button></>}>
      <div className="form-grid">
        <Field label="Upload the portal's response file" hint="Optional — fills the fields below">
          <input type="file" accept=".json,application/json" onChange={(e) => e.target.files[0] && readFile(e.target.files[0])} />
        </Field>
        <Field label="IRN" required>
          <input className="mono" value={f.irn} onChange={(e) => setF({ ...f, irn: e.target.value.trim() })} placeholder="64-character code" />
        </Field>
        <div className="row-2">
          <Field label="Ack No" required>
            <input value={f.ackNo} onChange={(e) => setF({ ...f, ackNo: e.target.value.trim() })} />
          </Field>
          <Field label="Ack Date" required>
            <input type="datetime-local" value={f.ackDate} onChange={(e) => setF({ ...f, ackDate: e.target.value })} />
          </Field>
        </div>
        <Field label="Signed QR Code" hint="Printed on the invoice as a QR code">
          <textarea rows={3} className="mono small" value={f.signedQr} onChange={(e) => setF({ ...f, signedQr: e.target.value.trim() })} />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

function CancelModal({ kind, doc, onClose, onSaved }) {
  const [reason, setReason] = useState("Data entry mistake");
  const save = async () => {
    try {
      const { data } = await api.post(`/gst/einvoice/${kind}/${doc._id}/cancel`, { reason });
      toast("e-Invoice marked cancelled");
      if (data.warning) toast(data.warning, "error");
      onSaved();
    } catch (x) {
      toast(errMsg(x), "error");
    }
  };
  return (
    <Modal open title="Cancel e-Invoice" onClose={onClose} footer={<><button className="btn btn-danger" onClick={save}>Mark Cancelled</button><button className="btn" onClick={onClose}>Back</button></>}>
      <div className="form-grid">
        <p className="muted">First cancel the IRN on the e-invoice portal (allowed within 24 hours). Then mark it cancelled here so you can edit or void the document.</p>
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {["Duplicate", "Data entry mistake", "Order cancelled", "Others"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function TransportModal({ doc, onClose, onSaved }) {
  const w = doc.eway || {};
  const ship = w.shipTo || {};
  const [f, setF] = useState({ transMode: w.transMode || "1", distance: w.distance || "", transporterName: w.transporterName || "", transporterId: w.transporterId || "", vehicleNo: w.vehicleNo || "", vehicleType: w.vehicleType || "R", transDocNo: w.transDocNo || "", transDocDate: w.transDocDate ? isoDate(w.transDocDate) : "", shipTo: { street: ship.street || "", city: ship.city || "", state: ship.state || "", pincode: ship.pincode || "" } });
  const [errors, setErrors] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const { data } = await api.put(`/gst/eway/${doc._id}/transport`, { ...f, distance: Number(f.distance || 0) });
      if (data.errors.length) setErrors(data.errors);
      else {
        toast("Transport details saved");
        onSaved();
      }
    } catch (x) {
      setErrors([errMsg(x)]);
    }
  };
  return (
    <Modal open wide title="Transport Details (e-Way Bill)" onClose={onClose} footer={<><button className="btn btn-primary" onClick={save}>Save</button><button className="btn" onClick={errors.length ? onSaved : onClose}>{errors.length ? "Save & fix later" : "Cancel"}</button></>}>
      <div className="form-grid">
        <div className="row-3">
          <Field label="Mode">
            <select value={f.transMode} onChange={set("transMode")}>
              {MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Approx. Distance (km)" required hint="From your PIN to the delivery PIN">
            <input type="number" min="1" max="4000" value={f.distance} onChange={set("distance")} />
          </Field>
          {f.transMode === "1" && (
            <Field label="Vehicle No" hint="Leave blank to let the transporter fill Part B">
              <input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} placeholder="MH12AB1234" />
            </Field>
          )}
        </div>
        <div className="row-3">
          <Field label="Transporter Name">
            <input value={f.transporterName} onChange={set("transporterName")} />
          </Field>
          <Field label="Transporter ID (GSTIN / TRANSIN)">
            <input value={f.transporterId} onChange={(e) => setF({ ...f, transporterId: e.target.value.toUpperCase() })} />
          </Field>
          {f.transMode !== "1" && (
            <Field label="Transport Doc No" required>
              <input value={f.transDocNo} onChange={set("transDocNo")} />
            </Field>
          )}
          {(f.transMode !== "1" || f.transDocNo) && (
            <Field label="Transport Doc Date">
              <input type="date" value={f.transDocDate} onChange={set("transDocDate")} />
            </Field>
          )}
        </div>
        <h4 className="section-title" style={{ margin: 0 }}>
          Ship To <span className="muted small">Leave blank to use the customer's billing address</span>
        </h4>
        <div className="row-3">
          <Field label="Address">
            <input value={f.shipTo.street} onChange={(e) => setF({ ...f, shipTo: { ...f.shipTo, street: e.target.value } })} />
          </Field>
          <Field label="City">
            <input value={f.shipTo.city} onChange={(e) => setF({ ...f, shipTo: { ...f.shipTo, city: e.target.value } })} />
          </Field>
          <Field label="PIN Code">
            <input value={f.shipTo.pincode} onChange={(e) => setF({ ...f, shipTo: { ...f.shipTo, pincode: e.target.value } })} />
          </Field>
        </div>
        <Field label="Delivery State">
          <select value={f.shipTo.state} onChange={(e) => setF({ ...f, shipTo: { ...f.shipTo, state: e.target.value } })}>
            <option value="">Same as place of supply</option>
            {STATES.map(([c, n]) => (
              <option key={c} value={c}>
                [{c}] {n}
              </option>
            ))}
          </select>
        </Field>
        {errors.length > 0 && (
          <div className="alert alert-error">
            Still needed before the JSON can be made:
            <ul className="err-list">
              {errors.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function EwbModal({ doc, onClose, onSaved }) {
  const [f, setF] = useState({ ewbNo: "", ewbDate: isoDate(), validUpto: "" });
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await api.post(`/gst/eway/${doc._id}/ewb`, f);
      toast("E-way bill recorded");
      onSaved();
    } catch (x) {
      setError(errMsg(x));
    }
  };
  return (
    <Modal open title="Record e-Way Bill" onClose={onClose} footer={<><button className="btn btn-primary" onClick={save}>Save</button><button className="btn" onClick={onClose}>Cancel</button></>}>
      <div className="form-grid">
        <Field label="E-Way Bill No" required>
          <input className="mono" maxLength={12} value={f.ewbNo} onChange={(e) => setF({ ...f, ewbNo: e.target.value.replace(/\D/g, "") })} placeholder="12 digits" />
        </Field>
        <div className="row-2">
          <Field label="Generated On" required>
            <input type="date" value={f.ewbDate} onChange={(e) => setF({ ...f, ewbDate: e.target.value })} />
          </Field>
          <Field label="Valid Until">
            <input type="date" value={f.validUpto} onChange={(e) => setF({ ...f, validUpto: e.target.value })} />
          </Field>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}
