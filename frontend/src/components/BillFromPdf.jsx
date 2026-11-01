import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
  const pick = async (fl, ai = false) => {
    if (!fl) return;
    setFile(fl);
    setReading(true);
    if (ai) setF(null);
    try {
      const b64 = ai && data ? data : await readB64(fl);
      setData(b64);
      const { data: p } = await api.post("/bill-scan/read", { name: fl.name, data: b64, ai });
      const today = new Date().toISOString().slice(0, 10);
      setF({
        scanned: !!p.scanned,
        ai: !!p.ai,
        aiAvailable: !!p.aiAvailable,
        lines: (p.lines || []).length > 1 ? p.lines : [],
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
  const multi = f && f.lines.length > 1;
  const taxable = !f ? 0 : multi ? r2(f.lines.reduce((s, l) => s + (Number(l.taxable) || 0), 0)) : Number(f.taxable) || 0;
  const tax = !f ? 0 : multi ? r2(f.lines.reduce((s, l) => s + ((Number(l.taxable) || 0) * (Number(l.rate) || 0)) / 100, 0)) : r2((taxable * (Number(f.rate) || 0)) / 100);
  const total = f ? r2(taxable + tax + (Number(f.adjustment) || 0)) : 0;
  const setLine = (i, k) => (e) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)) });
  const create = async () => {
    setBusy(true);
    try {
      const { data: r } = await api.post("/bill-scan/create", { kind, ...f, ai: undefined, aiAvailable: undefined, scanned: undefined, message: undefined, notes: undefined, total: undefined, cgst: undefined, sgst: undefined, igst: undefined, lines: kind === "bill" && multi ? f.lines.map((l) => ({ description: l.description || "", hsn: l.hsn || "", quantity: Number(l.quantity) || 1, unit: l.unit || "", taxable: Number(l.taxable) || 0, rate: Number(l.rate) || 0 })) : [], taxable: multi ? taxable : Number(f.taxable) || 0, rate: Number(f.rate) || 0, adjustment: kind === "bill" ? Number(f.adjustment) || 0 : 0, dueDate: f.dueDate || null, name: file?.name, data, paidThrough: f.paidThrough === "cash" ? "cash" : "bank" });
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
            <button className="btn btn-primary" disabled={busy || !(taxable > 0) || (kind === "bill" && !f.vendorId && !f.vendorName)} onClick={create}>
              {busy ? "Creating…" : kind === "bill" ? "Create Bill" : "Create Expense"}
            </button>
          </>
        )
      }
    >
      {!f ? (
        <label className="dropzone" style={{ display: "flex" }}>
          {reading ? <Spinner /> : <>{file ? <strong>{file.name}</strong> : "Choose the supplier's bill (PDF), or take a photo"}</>}
          <span className="muted small">PDFs, scans and phone photos are read automatically (scans and photos need Gemini under Settings → Integrations). The file is attached to what you create.</span>
          <input type="file" hidden accept="application/pdf,image/*" onChange={(e) => pick(e.target.files[0])} />
        </label>
      ) : (
        <div className="form-grid">
          {f.scanned && (
            <div className="alert alert-warn">
              {f.message} {!f.aiAvailable && <Link to="/settings#integrations" onClick={onClose}>Set up Gemini</Link>}
            </div>
          )}
          {!f.scanned && (
            <div className="alert alert-info">
              {f.ai ? "Read by Google Gemini" : "Read"} from {file?.name}. Check each field before creating.{f.notes.length ? ` ${f.notes.join(". ")}.` : ""}
              {!f.ai && f.aiAvailable && (
                <>
                  {" "}
                  <button type="button" className="link-btn" onClick={() => pick(file, true)}>
                    Read again with Gemini
                  </button>
                </>
              )}
            </div>
          )}
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
            {!multi && (
              <Field label={kind === "bill" ? "Item / description" : "Description"}>
                <input value={f.description} onChange={set("description")} placeholder={`As per bill ${f.billNumber}`} />
              </Field>
            )}
            {kind === "expense" ? (
              <Field label="Expense account">
                <select value={f.account} onChange={set("account")}>
                  {cats.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            ) : (
              !multi && (
                <Field label="HSN/SAC">
                  <input value={f.hsn} onChange={set("hsn")} />
                </Field>
              )
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
          {multi && (
            <div className="line-table-wrap">
              <table className="table bill-lines">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>HSN</th>
                    <th className="num">Qty</th>
                    <th className="num">Taxable</th>
                    <th className="num">GST %</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {f.lines.map((l, i) => (
                    <tr key={i}>
                      <td data-label="Item"><input value={l.description} onChange={setLine(i, "description")} /></td>
                      <td data-label="HSN"><input value={l.hsn} onChange={setLine(i, "hsn")} style={{ width: 90 }} /></td>
                      <td data-label="Qty" className="num"><input type="number" value={l.quantity} onChange={setLine(i, "quantity")} style={{ width: 70 }} /></td>
                      <td data-label="Taxable" className="num"><input type="number" step="0.01" value={l.taxable} onChange={setLine(i, "taxable")} style={{ width: 110 }} /></td>
                      <td data-label="GST %" className="num">
                        <select value={l.rate} onChange={setLine(i, "rate")}>
                          {GST_RATES.concat([40]).map((r) => (
                            <option key={r} value={r}>{r}%</option>
                          ))}
                        </select>
                      </td>
                      <td className="line-del">
                        <button type="button" className="icon-btn" title="Remove line" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {multi ? (
            <div className="row-3">
              <Field label="Taxable value">
                <input readOnly value={money(taxable)} />
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
          ) : (
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
          )}
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
