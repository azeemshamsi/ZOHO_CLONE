import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader, Field, toast } from "../components/ui";
import Icon from "../components/Icon";

const TYPES = [
  ["", "Detect automatically"],
  ["accounts", "Chart of accounts"],
  ["customers", "Customers (debtors)"],
  ["vendors", "Vendors (creditors)"],
  ["openingBalances", "Opening balances / trial balance"],
  ["invoices", "Invoices"],
  ["bills", "Bills"],
  ["creditNotes", "Credit notes"],
  ["vendorCredits", "Vendor credits / debit notes"],
  ["payments", "Customer payments"],
  ["vendorPayments", "Vendor payments"],
  ["expenses", "Expenses"],
  ["journals", "Journals"],
];
const SOURCE = { zoho: "Zoho Books", tally: "Tally ERP / TallyPrime", sheet: "Spreadsheet" };
const ORDER = "Chart of accounts → Customers & vendors → Opening balances → Invoices & bills → Payments → Expenses → Journals";

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

function download(type) {
  api.get(`/import/templates/${type}`, { responseType: "blob" }).then((r) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.data);
    a.download = `ordexago-${type}-template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

export function Import() {
  const [file, setFile] = useState(null);
  const [type, setType] = useState("");
  const [preview, setPreview] = useState(null);
  const [openingDate, setOpeningDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [drag, setDrag] = useState(false);
  const input = useRef();
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setJob(null);
    setType("");
    if (input.current) input.current.value = "";
  };

  const runPreview = async (f = file, t = type) => {
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) return toast("Files up to 25 MB can be imported. Split bigger exports by date range.", "error");
    setBusy(true);
    setPreview(null);
    try {
      const data = await readBase64(f);
      const { data: p } = await api.post("/import/preview", { fileName: f.name, data, type: t || undefined });
      setPreview(p);
      if (p.hasOpening && !openingDate && p.firstDate) {
        // Default: 1 April of the financial year of the earliest transaction, else the first of this FY.
        const d = new Date(p.firstDate);
        const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
        setOpeningDate(`${fy}-04-01`);
      } else if (p.hasOpening && !openingDate) {
        const d = new Date();
        setOpeningDate(`${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1}-04-01`);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };

  const pick = (f) => {
    if (!f) return;
    setFile(f);
    setJob(null);
    runPreview(f, type);
  };

  const poll = (id) => {
    api
      .get(`/import/jobs/${id}`)
      .then(({ data }) => {
        setJob({ id, ...data });
        if (data.status === "running") timer.current = setTimeout(() => poll(id), 700);
      })
      .catch((e) => toast(errMsg(e), "error"));
  };

  const start = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/import/commit", { id: preview.id, openingDate: preview.hasOpening ? openingDate : undefined });
      setJob({ id: data.jobId, status: "running", done: 0, total: 1 });
      poll(data.jobId);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };

  const results = job?.results ? Object.entries(job.results) : [];
  const created = results.reduce((s, [, r]) => s + r.created, 0);
  const failed = results.reduce((s, [, r]) => s + r.failed.length, 0);

  return (
    <>
      <PageHeader title="Import Data" subtitle="Bring your books over from Zoho Books, Tally ERP 9 / TallyPrime, or any spreadsheet." />

      {!job && (
        <div className="grid-side import-grid">
          <div className="card">
            <h3 className="card-title pad">1. Choose a file</h3>
            <div
              className={`dropzone${drag ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                pick(e.dataTransfer.files[0]);
              }}
              onClick={() => input.current?.click()}
            >
              <Icon name="doc" size={28} />
              <div>{file ? <strong>{file.name}</strong> : "Drop a file here, or click to browse"}</div>
              <div className="muted small">Excel (.xlsx, .xls), CSV, or XML — up to 25 MB</div>
              <input ref={input} type="file" hidden accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,.tsv,.xml" onChange={(e) => pick(e.target.files[0])} />
            </div>
            <Field label="What's in this file?" hint="Leave on automatic — OrdexaGo reads the column names. Change it only if a sheet isn't recognised.">
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  if (file) runPreview(file, e.target.value);
                }}
              >
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            {busy && !preview && <p className="muted">Reading the file…</p>}
          </div>

          <div className="card import-help">
            <h3 className="card-title pad">How to export</h3>
            <p>
              <strong>Zoho Books:</strong> open the module (Chart of Accounts, Customers, Vendors, Invoices, Bills, Customer Payments, Vendor Payments, Expenses, Manual Journals), then <em>⋯ → Export</em>. Choose CSV or XLSX. For opening balances, export the Trial Balance report as of the day before your start date.
            </p>
            <p>
              <strong>Tally ERP 9 / TallyPrime:</strong> <em>Display → List of Accounts</em> (or <em>Day Book</em> for vouchers), then <em>Export (Alt+E)</em> with Format = <em>XML (Data Interchange)</em>. Masters bring ledgers, groups, opening balances and bill-wise outstanding; the Day Book brings Sales, Purchase, Receipt, Payment, Credit/Debit Note and Journal vouchers. Excel exports of the ledger list or trial balance work too.
            </p>
            <p className="muted small">Import in this order: {ORDER}. Re-importing the same file is safe — records already brought in are skipped.</p>
            <div className="template-links">
              <span className="muted small">CSV templates:</span>
              {TYPES.slice(1).map(([v, l]) => (
                <button key={v} className="link-btn small" onClick={() => download(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {preview && !job && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <h3 className="card-title pad">2. Check what was found</h3>
            <span className="badge">{SOURCE[preview.source]}</span>
          </div>
          {preview.datasets.map((d) => (
            <div key={d.type} className="import-set">
              <div className="import-set-head">
                <strong>{d.label}</strong> <span className="muted">— {d.count} record{d.count === 1 ? "" : "s"}</span>
              </div>
              <div className="card flush">
                <table className="table compact">
                  <thead>
                    <tr>
                      {Object.keys(d.sample[0] || {}).map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.sample.map((r, i) => (
                      <tr key={i}>
                        {Object.values(r).map((v, j) => (
                          <td key={j}>{v === null || v === undefined ? "" : String(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.count > d.sample.length && <div className="muted small">…and {d.count - d.sample.length} more</div>}
            </div>
          ))}
          {preview.warnings.length > 0 && (
            <div className="alert alert-warn">
              {preview.warnings.slice(0, 12).map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {preview.warnings.length > 12 && <div>…and {preview.warnings.length - 12} more</div>}
            </div>
          )}

          <h3 className="card-title pad" style={{ marginTop: 18 }}>
            3. Import
          </h3>
          {preview.hasOpening && (
            <Field label="Opening balance date" required hint="The date your books in OrdexaGo start from. Opening balances are posted on this date, against Opening Balance Equity.">
              <input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} style={{ maxWidth: 200 }} />
            </Field>
          )}
          <div className="row-actions">
            <button className="btn btn-primary" disabled={busy || (preview.hasOpening && !openingDate)} onClick={start}>
              Import {preview.datasets.reduce((s, d) => s + d.count, 0)} records
            </button>
            <button className="btn" onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {job && (
        <div className="card">
          {job.status === "running" ? (
            <>
              <h3 className="card-title pad">Importing…</h3>
              <div className="progress">
                <div style={{ width: `${Math.round((job.done / Math.max(job.total, 1)) * 100)}%` }} />
              </div>
              <p className="muted">
                {job.done} of {job.total} — you can leave this page; the import keeps running.
              </p>
            </>
          ) : job.status === "failed" ? (
            <div className="alert alert-error">The import stopped: {job.error}</div>
          ) : (
            <>
              <h3 className="card-title pad">
                <Icon name="check" /> Import finished — {created} created{failed ? `, ${failed} failed` : ""}
              </h3>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th className="num">Created</th>
                    <th className="num">Already there (skipped)</th>
                    <th className="num">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(([k, r]) => (
                    <tr key={k}>
                      <td>{job.labels?.[k] || k}</td>
                      <td className="num">{r.created}</td>
                      <td className="num">{r.skipped}</td>
                      <td className="num">{r.failed.length || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {failed > 0 && (
                <div className="alert alert-error" style={{ marginTop: 12 }}>
                  {results
                    .flatMap(([k, r]) => r.failed.map((f) => `${job.labels?.[k] || k} — ${f.ref}: ${f.error}`))
                    .slice(0, 50)
                    .map((t, i) => (
                      <div key={i}>{t}</div>
                    ))}
                </div>
              )}
              {job.warnings?.length > 0 && (
                <div className="alert alert-warn">
                  {job.warnings.slice(0, 50).map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
              <div className="row-actions" style={{ marginTop: 14 }}>
                <button className="btn btn-primary" onClick={reset}>
                  Import Another File
                </button>
                <Link className="btn" to="/reports/balance-sheet">
                  Check Balance Sheet
                </Link>
                <Link className="btn" to="/reports/trial-balance">
                  Trial Balance
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
