import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, toast } from "../components/ui";
import Icon from "../components/Icon";

// Sales → Amazon: import Amazon's Merchant Tax Report (B2C / B2B) and check the month against Amazon's GSTR-1.

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, data: r.result });
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
const monthLabel = (m) => (m ? new Date(`${m}-15T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) : "");

export default function AmazonSales() {
  const [list, setList] = useState(null);
  const [check, setCheck] = useState(null); // { month, result }
  const loadMonths = () =>
    api
      .get("/amazon/months")
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    loadMonths();
  }, []);
  return (
    <>
      <PageHeader title="Amazon Sales" subtitle="Import Amazon's Merchant Tax Report and check it against Amazon's GSTR-1 report" />
      <ImportBox
        onImported={(month, gstr1Files) => {
          loadMonths();
          if (gstr1Files?.length) runCheck(month, gstr1Files, setCheck);
        }}
      />
      <div className="card" style={{ marginTop: 16, overflowX: "auto" }}>
        <div className="card-head">
          <h3>Imported months</h3>
        </div>
        {!list ? (
          <Spinner />
        ) : !list.months.length ? (
          <Empty title="Nothing imported yet" text="Upload Amazon's MTR B2C and B2B reports (the zips as downloaded are fine)." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Month (Amazon report)</th>
                <th>GSTIN</th>
                <th className="num">Invoices</th>
                <th className="num">of which B2B</th>
                <th className="num">Credit notes</th>
                <th className="num">Taxable (net)</th>
                <th className="num">Value (net)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.months.map((m) => (
                <tr key={`${m.gstin}-${m.month}`}>
                  <td className="strong">{monthLabel(m.month)}</td>
                  <td className="small">{m.gstin}</td>
                  <td className="num">{m.invoices}</td>
                  <td className="num">{m.b2b}</td>
                  <td className="num">{m.creditNotes}</td>
                  <td className="num">{money(m.taxable)}</td>
                  <td className="num">{money(m.value)}</td>
                  <td className="num">
                    <CheckButton month={m.month} onResult={setCheck} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {check && <CheckResult r={check} onClose={() => setCheck(null)} />}
    </>
  );
}

async function runCheck(month, files, setCheck) {
  try {
    const { data } = await api.post("/amazon/reconcile", { month, files });
    setCheck(data);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function CheckButton({ month, onResult }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const fs = [...(e.target.files || [])];
    e.target.value = "";
    if (!fs.length) return;
    setBusy(true);
    await runCheck(month, await Promise.all(fs.map(readFile)), onResult);
    setBusy(false);
  };
  return (
    <>
      <input ref={ref} type="file" multiple accept=".xlsx,.zip" style={{ display: "none" }} onChange={pick} />
      <button className="btn btn-sm" disabled={busy} onClick={() => ref.current?.click()} title="Upload Amazon's GSTR-1 report for this month">
        {busy ? "Checking…" : "Check with Amazon GSTR-1"}
      </button>
    </>
  );
}

function ImportBox({ onImported }) {
  const [files, setFiles] = useState([]);
  const [raw, setRaw] = useState([]);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ledgers, setLedgers] = useState([]);
  const [ledger, setLedger] = useState("");
  const [job, setJob] = useState(null);
  useEffect(() => {
    api
      .get("/accounts")
      .then((r) => setLedgers(r.data.filter((a) => a.ledgerKind === "sales" || (a.group === "Income" && a.active !== false))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const a = ledgers.find((l) => l.name === "Amazon Sales");
    if (a && !ledger) setLedger(a.code || a._id);
  }, [ledgers]);

  const choose = async (e) => {
    const fs = [...(e.target.files || [])];
    setFiles(fs);
    setPv(null);
    setJob(null);
    setRaw(await Promise.all(fs.map(readFile)));
  };
  const preview = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/amazon/preview", { files: raw });
      setPv(data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const start = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/amazon/import", { planId: pv.planId, ledger });
      setJob(data);
      const poll = setInterval(async () => {
        try {
          const { data: j } = await api.get(`/amazon/jobs/${data.id}`);
          setJob(j);
          if (j.status !== "running") {
            clearInterval(poll);
            setBusy(false);
            toast(`Imported ${j.created.invoices} invoices and ${j.created.creditNotes} credit notes${j.errors.length ? ` · ${j.errors.length} not imported` : ""}`, j.errors.length ? "error" : undefined);
            const gstr1 = raw.filter((f) => /gstr/i.test(f.name) || /\.xlsx$/i.test(f.name) || /\.zip$/i.test(f.name));
            onImported(pv.month, pv.hasGstr1 ? gstr1 : []);
          }
        } catch {}
      }, 1500);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const row = (label, p) => (
    <tr>
      <td>{label}</td>
      <td className="num">{p.count}</td>
      <td className="num">{money(p.taxable)}</td>
      <td className="num">{money(p.tax)}</td>
      <td className="num strong">{money(p.value)}</td>
      <td className="num muted">{money(p.tcs)}</td>
    </tr>
  );
  const net = pv && { taxable: pv.b2cInvoices.taxable + pv.b2bInvoices.taxable + pv.creditNotes.taxable, tax: pv.b2cInvoices.tax + pv.b2bInvoices.tax + pv.creditNotes.tax, value: pv.b2cInvoices.value + pv.b2bInvoices.value + pv.creditNotes.value, tcs: pv.b2cInvoices.tcs + pv.b2bInvoices.tcs + pv.creditNotes.tcs };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Import from Amazon</h3>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Seller Central → Reports → Tax Document Library: download <strong>MTR B2C</strong> and <strong>MTR B2B</strong> for the month (and the <strong>GSTR-1 report</strong> to check against). Upload the zips as they are. Each Amazon invoice becomes an invoice (B2C to "Amazon B2C", B2B to the buyer), each refund a credit note; cancellations, free replacements and other GSTINs are skipped. Importing the same month again only adds what's new.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input type="file" multiple accept=".zip,.csv,.xlsx" onChange={choose} />
        <button className="btn btn-primary" disabled={!raw.length || busy} onClick={preview}>
          {busy && !pv ? "Reading…" : "Preview"}
        </button>
      </div>
      {files.length > 0 && !pv && <p className="small muted">{files.map((f) => f.name).join(", ")}</p>}
      {pv && (
        <div style={{ marginTop: 14 }}>
          <p className="small" style={{ margin: "0 0 8px" }}>
            <strong>{monthLabel(pv.month)}</strong> · seller GSTIN {pv.gstin} · {pv.files.join(" · ")}
            {pv.unknownFiles.length > 0 && <span style={{ color: "var(--red)" }}> · not recognised: {pv.unknownFiles.join(", ")}</span>}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>From Amazon's MTR</th>
                <th className="num">Documents</th>
                <th className="num">Taxable</th>
                <th className="num">GST</th>
                <th className="num">Value</th>
                <th className="num">TCS by Amazon</th>
              </tr>
            </thead>
            <tbody>
              {row("B2C invoices", pv.b2cInvoices)}
              {row("B2B invoices", pv.b2bInvoices)}
              {row("Refunds (credit notes)", pv.creditNotes)}
              <tr className="row-total">
                <td>Net sales</td>
                <td />
                <td className="num">{money(net.taxable)}</td>
                <td className="num">{money(net.tax)}</td>
                <td className="num">{money(net.value)}</td>
                <td className="num">{money(net.tcs)}</td>
              </tr>
            </tbody>
          </table>
          <ul className="small" style={{ margin: "10px 0", paddingLeft: 18 }}>
            <li>
              <strong>{pv.toCreate}</strong> to create{pv.alreadyImported ? ` · ${pv.alreadyImported} already imported (left as they are)` : ""}
              {pv.conflicts.length > 0 && <span style={{ color: "var(--red)" }}> · {pv.conflicts.length} numbers already used by other documents, skipped: {pv.conflicts.slice(0, 8).join(", ")}{pv.conflicts.length > 8 ? "…" : ""}</span>}
            </li>
            <li>
              Skipped lines: {pv.skipped.cancel} cancelled, {pv.skipped.freeReplacement} free replacements
              {Object.entries(pv.skipped.otherGstin).map(([g, n]) => ` · ${n} of GSTIN ${g}`)}
            </li>
            {pv.newBuyers.length > 0 && <li>{pv.newBuyers.length} new B2B customers will be created: {pv.newBuyers.slice(0, 5).join(", ")}{pv.newBuyers.length > 5 ? "…" : ""}</li>}
            {pv.unmatchedSkus.length > 0 && (
              <li>
                {pv.unmatchedSkus.length} Amazon SKUs have no item in OrdexaGo — those lines are imported without stock movement:{" "}
                <span className="muted">{pv.unmatchedSkus.slice(0, 12).map((s) => s.sku).join(", ")}{pv.unmatchedSkus.length > 12 ? "…" : ""}</span>
              </li>
            )}
          </ul>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Sales ledger">
              <select value={ledger} onChange={(e) => setLedger(e.target.value)}>
                {!ledgers.some((l) => l.name === "Amazon Sales") && <option value="">Amazon Sales (new ledger)</option>}
                {ledgers.map((l) => (
                  <option key={l.code || l._id} value={l.code || l._id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-primary" disabled={busy || !pv.toCreate} onClick={start}>
              <Icon name="upload" size={16} /> Import {pv.toCreate} documents
            </button>
          </div>
          {job && (
            <div style={{ marginTop: 12 }}>
              <div className="meter">
                <div className="meter-current" style={{ width: `${job.total ? (job.done / job.total) * 100 : 100}%` }} />
              </div>
              <p className="small" style={{ margin: "6px 0" }}>
                {job.status === "running" ? `Importing… ${job.done} of ${job.total}` : `Done: ${job.created.invoices} invoices, ${job.created.creditNotes} credit notes created`}
                {job.errors.length > 0 && <span style={{ color: "var(--red)" }}> · {job.errors.length} not imported</span>}
              </p>
              {job.errors.length > 0 && (
                <ul className="small" style={{ color: "var(--red)", margin: 0, paddingLeft: 18 }}>
                  {job.errors.slice(0, 15).map((e, i) => (
                    <li key={i}>
                      {e.number}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {job.warnings.length > 0 && (
                <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                  {job.warnings.slice(0, 15).map((e, i) => (
                    <li key={i}>
                      {e.number}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckResult({ r, onClose }) {
  const [tab, setTab] = useState("b2c");
  const S = r.sections;
  const TABS = [
    ["b2c", "B2C (state & rate)", S.b2c],
    ["b2b", "B2B invoices", S.b2b],
    ["cdnr", "B2B credit notes", S.cdnr],
    ["hsn", "HSN summary", S.hsn],
  ];
  const bad = (sec) => sec.rows.filter((x) => !x.ok).length;
  return (
    <div className="card" style={{ marginTop: 16, overflowX: "auto" }}>
      <div className="card-head">
        <h3>
          {monthLabel(r.month)} · OrdexaGo vs Amazon's GSTR-1 ({r.gstin})
        </h3>
        <button className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {r.file} · imported for this month: {r.imported.invoices} invoices, {r.imported.creditNotes} credit notes, net taxable {money(r.imported.taxable)}, net value {money(r.imported.value)}.
      </p>
      <div className="tabs" style={{ marginBottom: 10 }}>
        {TABS.map(([k, l, sec]) => (
          <button key={k} type="button" className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {sec.ok ? "✓" : "✗"} {l} <span className={`tab-count ${sec.ok ? "" : "red"}`}>{sec.ok ? sec.rows.length : `${bad(sec)} off`}</span>
          </button>
        ))}
      </div>
      {(tab === "b2c" || tab === "hsn") && (
        <table className="table">
          <thead>
            <tr>
              <th>{tab === "b2c" ? "Place of supply @ rate" : "HSN @ rate"}</th>
              <th className="num">Amazon taxable</th>
              <th className="num">OrdexaGo taxable</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {S[tab].rows.map((x) => (
              <tr key={x.key} style={x.ok ? undefined : { background: "var(--red-50)" }}>
                <td>{x.label}</td>
                <td className="num">{money(x.amazon)}</td>
                <td className="num">{money(x.ordexago)}</td>
                <td className="num">{x.ok ? "✓" : money(x.diff)}</td>
              </tr>
            ))}
            <tr className="row-total">
              <td>Total</td>
              <td className="num">{money(S[tab].amazon)}</td>
              <td className="num">{money(S[tab].ordexago)}</td>
              <td className="num">{Math.abs(S[tab].amazon - S[tab].ordexago) < 0.05 ? "✓" : money(S[tab].ordexago - S[tab].amazon)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {(tab === "b2b" || tab === "cdnr") && (
        <table className="table">
          <thead>
            <tr>
              <th>{tab === "b2b" ? "Invoice" : "Credit note"}</th>
              {tab === "b2b" && <th>Buyer GSTIN</th>}
              <th className="num">Amazon value</th>
              <th className="num">Amazon taxable</th>
              <th className="num">OrdexaGo value</th>
              <th className="num">OrdexaGo taxable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {S[tab].rows.map((x) => (
              <tr key={x.number} style={x.ok ? undefined : { background: "var(--red-50)" }}>
                <td>{x.id ? <Link to={`/${tab === "b2b" ? "invoices" : "credit-notes"}/${x.id}`}>{x.number}</Link> : x.number}</td>
                {tab === "b2b" && <td className="small">{x.gstin}</td>}
                <td className="num">{x.amazon ? money(x.amazon.value) : "—"}</td>
                <td className="num">{x.amazon ? money(x.amazon.taxable) : "—"}</td>
                <td className="num">{x.ordexago ? money(x.ordexago.value) : "—"}</td>
                <td className="num">{x.ordexago ? money(x.ordexago.taxable) : "—"}</td>
                <td className="small">{x.ok ? "✓" : !x.ordexago ? "Not in OrdexaGo" : !x.amazon ? "Not in Amazon's GSTR-1" : "Differs"}</td>
              </tr>
            ))}
            {!S[tab].rows.length && (
              <tr>
                <td colSpan={7} className="muted center">
                  None this month
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
