import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { STATES, GST_RATES } from "../lib/constants";
import { Modal, Field, Spinner, toast } from "./ui";

const readB64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Upload a supplier's bill (PDF) → check what was read → create a purchase bill or an expense, with the PDF attached.
export default function BillFromPdf({ kind = "bill", onClose }) {
  const nav = useNavigate();
  const [file, setFile] = useState(null);
  const [data, setData] = useState(null);
  const [reading, setReading] = useState(false);
  const [f, setF] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/vendors").then((r) => setVendors(r.data)).catch(() => {});
    if (kind === "expense") api.get("/expenses/categories").then((r) => setCats(r.data)).catch(() => {});
  }, [kind]);
  const pick = async (fl) => {
    if (!fl) return;
    setFile(fl);
    setReading(true);
    try {
      const b64 = await readB64(fl);
      setData(b64);
      const { data: p } = await api.post("/bill-scan/read", { name: fl.name, data: b64 });
      const today = new Date().toISOString().slice(0, 10);
      setF({
        scanned: !!p.scanned,
        message: p.message || "",
        notes: p.notes || [],
        vendorId: p.vendor?._id || "",
        vendorName: p.vendor?.name || p.supplierName || "",
        vendorGstin: p.supplierGstin || "",
        billNumber: p.billNumber || "",
        date: p.date || today,
        dueDate: p.dueDate || "",
        placeOfSupply: p.placeOfSupply || "",
        description: "",
        hsn: p.hsn || "",
        taxable: p.taxable || "",
        rate: p.rate ?? 18,
        adjustment: p.adjustment || 0,
        total: p.total || 0,
        cgst: p.cgst,
        sgst: p.sgst,
        igst: p.igst,
        account: "",
        paidThrough: "bank",
        status: "draft",
      });
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setReading(false);
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const tax = f ? r2((Number(f.taxable) || 0) * (Number(f.rate) || 0) / 100) : 0;
  const total = f ? r2((Number(f.taxable) || 0) + tax + (Number(f.adjustment) || 0)) : 0;
  const create = async () => {
    setBusy(true);
    try {
      const { data: r } = await api.post("/bill-scan/create", { kind, ...f, taxable: Number(f.taxable) || 0, rate: Number(f.rate) || 0, adjustment: kind === "bill" ? Number(f.adjustment) || 0 : 0, dueDate: f.dueDate || null, name: file?.name, data, paidThrough: f.paidThrough === "cash" ? "cash" : "bank" });
      toast(`${r.docType === "bill" ? "Bill" : "Expense"} created${r.attachment ? " with the PDF attached" : ""}`);
      onClose();
      nav(r.docType === "bill" ? `/bills/${r._id}` : `/expenses/${r._id}/edit`);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      title={kind === "bill" ? "New bill from PDF" : "New expense from a bill"}
      onClose={onClose}
      footer={
        f && (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !(Number(f.taxable) > 0) || (kind === "bill" && !f.vendorId && !f.vendorName)} onClick={create}>
              {busy ? "Creating…" : kind === "bill" ? "Create Bill" : "Create Expense"}
            </button>
          </>
        )
      }
    >
      {!f ? (
        <label className="dropzone" style={{ display: "flex" }}>
          {reading ? <Spinner /> : <>{file ? <strong>{file.name}</strong> : "Choose the supplier's bill (PDF), or take a photo"}</>}
          <span className="muted small">Text PDFs (e-invoices, system-generated bills) are read automatically. Photos and scans are attached and you fill in the amounts.</span>
          <input type="file" hidden accept="application/pdf,image/*" onChange={(e) => pick(e.target.files[0])} />
        </label>
      ) : (
        <div className="form-grid">
          {f.scanned && <div className="alert alert-warn">{f.message}</div>}
          {!f.scanned && <div className="alert alert-info">Read from {file?.name}. Check each field before creating.{f.notes.length ? ` ${f.notes.join(". ")}.` : ""}</div>}
          <div className="row-2">
            <Field label="Supplier" required={kind === "bill"} hint={f.vendorId ? "Existing vendor" : f.vendorName ? "Will be created as a new vendor" : ""}>
              <select value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value, vendorName: e.target.value ? vendors.find((v) => v._id === e.target.value)?.displayName || "" : f.vendorName })}>
                <option value="">{f.vendorName ? `New: ${f.vendorName}` : "Choose…"}</option>
                {vendors.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.displayName}
                    {v.gstin ? ` (${v.gstin})` : ""}
                  </option>
                ))}
              </select>
            </Field>
            {!f.vendorId && (
              <div className="row-2">
                <Field label="New supplier name">
                  <input value={f.vendorName} onChange={set("vendorName")} />
                </Field>
                <Field label="GSTIN">
                  <input value={f.vendorGstin} onChange={(e) => setF({ ...f, vendorGstin: e.target.value.toUpperCase() })} />
                </Field>
              </div>
            )}
          </div>
          <div className="row-3">
            <Field label="Bill number">
              <input value={f.billNumber} onChange={set("billNumber")} />
            </Field>
            <Field label="Bill date" required>
              <input type="date" value={f.date} onChange={set("date")} />
            </Field>
            {kind === "bill" ? (
              <Field label="Due date">
                <input type="date" value={f.dueDate} onChange={set("dueDate")} />
              </Field>
            ) : (
              <Field label="Paid through">
                <select value={f.paidThrough} onChange={set("paidThrough")}>
                  <option value="bank">Bank</option>
                  <option value="cash">Cash</option>
                </select>
              </Field>
            )}
          </div>
          <div className="row-3">
            <Field label={kind === "bill" ? "Item / description" : "Description"}>
              <input value={f.description} onChange={set("description")} placeholder={`As per bill ${f.billNumber}`} />
            </Field>
            {kind === "expense" ? (
              <Field label="Expense account">
                <select value={f.account} onChange={set("account")}>
                  {cats.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="HSN/SAC">
                <input value={f.hsn} onChange={set("hsn")} />
              </Field>
            )}
            <Field label="Place of supply">
              <select value={f.placeOfSupply} onChange={set("placeOfSupply")}>
                <option value="">From supplier GSTIN</option>
                {STATES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-4">
            <Field label="Taxable value" required>
              <input type="number" step="0.01" value={f.taxable} onChange={set("taxable")} />
            </Field>
            <Field label="GST %">
              <select value={f.rate} onChange={set("rate")}>
                {GST_RATES.concat([40]).map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
            </Field>
            {kind === "bill" && (
              <Field label="Round-off / other">
                <input type="number" step="0.01" value={f.adjustment} onChange={set("adjustment")} />
              </Field>
            )}
            <Field label="Total">
              <input readOnly value={money(total)} />
            </Field>
          </div>
          {f.total > 0 && Math.abs(total - f.total) > 0.5 && <div className="alert alert-warn">The bill says {money(f.total)}; these fields make {money(total)}.</div>}
          {(f.igst > 0 || f.cgst > 0) && (
            <p className="muted small">
              On the bill: {f.igst > 0 ? `IGST ${money(f.igst)}` : `CGST ${money(f.cgst)} + SGST ${money(f.sgst)}`} · total {money(f.total)}
            </p>
          )}
          {kind === "bill" && (
            <label className="check">
              <input type="checkbox" checked={f.status === "open"} onChange={(e) => setF({ ...f, status: e.target.checked ? "open" : "draft" })} /> Save as open (post to the books now) — otherwise it's saved as a draft to check
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
