import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { STATES } from "../lib/constants";
import { PageHeader, Spinner, Modal, Field, toast } from "../components/ui";
import { can } from "../components/Layout";

const stateName = (c) => (STATES.find(([k]) => k === c) || [c, c])[1];
const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const currentFy = () => {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
};
const fyOptions = () => {
  const y = +currentFy().slice(0, 4);
  return [y + 0, y - 1, y - 2, y - 3].map((v) => `${v}-${String(v + 1).slice(2)}`);
};
export async function download(url, params, name) {
  try {
    const r = await api.get(url, { params, responseType: "blob" });
    const cd = r.headers["content-disposition"] || "";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.data);
    a.download = /filename="([^"]+)"/.exec(cd)?.[1] || name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) {
    let msg = errMsg(e);
    try {
      msg = JSON.parse(await e.response.data.text()).message || msg;
    } catch {}
    toast(msg, "error");
  }
}
const Amt = ({ v }) => <span className="num">{money(v || 0)}</span>;

function FiledBox({ form, period, filing, onDone, summary, canEdit }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ arn: "", filedOn: isoDate(), amountPaid: "", notes: "" });
  const save = async () => {
    try {
      await api.post("/gst/returns/filings", { form, period, ...f, amountPaid: Number(f.amountPaid) || 0, summary });
      toast(`${form} marked as filed`);
      setOpen(false);
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const undo = async () => {
    if (!window.confirm(`Mark ${form} as not filed?`)) return;
    await api.delete(`/gst/returns/filings/${filing._id}`);
    onDone();
  };
  if (filing)
    return (
      <div className="filed-box">
        <span className="pill pill-green">Filed {date(filing.filedOn)}</span>
        {filing.arn && <span className="muted small">ARN {filing.arn}</span>}
        {canEdit && (
          <button className="link-btn small" onClick={undo}>
            Undo
          </button>
        )}
      </div>
    );
  return (
    <>
      {canEdit && (
        <button className="btn" onClick={() => setOpen(true)}>
          Mark as filed
        </button>
      )}
      <Modal
        open={open}
        title={`Mark ${form} as filed`}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!f.filedOn}>
              Save
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="ARN (acknowledgement number)" hint="Shown on the portal after filing">
            <input value={f.arn} onChange={(e) => setF({ ...f, arn: e.target.value.toUpperCase() })} placeholder="AA2707261234567" />
          </Field>
          <div className="row-2">
            <Field label="Filed on" required>
              <input type="date" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} />
            </Field>
            <Field label="Tax paid in cash">
              <input type="number" step="0.01" value={f.amountPaid} onChange={(e) => setF({ ...f, amountPaid: e.target.value })} />
            </Field>
          </div>
          <Field label="Notes">
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function Issues({ list }) {
  if (!list?.length) return <div className="alert alert-success">No problems found in this period's documents.</div>;
  return (
    <div className="alert alert-warn">
      <strong>
        {list.length} thing{list.length > 1 ? "s" : ""} to fix before filing
      </strong>
      <ul className="issue-list">
        {list.slice(0, 12).map((i, n) => (
          <li key={n}>
            {i.id ? <Link to={`/${i.kind === "invoice" ? "invoices" : "credit-notes"}/${i.id}`}>{i.doc}</Link> : null} {i.problem}
          </li>
        ))}
        {list.length > 12 && <li>…and {list.length - 12} more</li>}
      </ul>
    </div>
  );
}

const SECTIONS = [
  ["b2b", "4A · B2B invoices", "Registered customers"],
  ["b2cl", "5 · B2C large", "Inter-state, unregistered, over ₹1 lakh"],
  ["b2cs", "7 · B2C small", "Grouped by state and rate"],
  ["exp", "6A · Exports", ""],
  ["cdnr", "9B · Credit notes (registered)", ""],
  ["cdnur", "9B · Credit notes (unregistered)", ""],
  ["nil", "8 · Nil rated / exempt", ""],
  ["hsnB2b", "12 · HSN summary — B2B", "Sales to registered customers (with GSTIN)"],
  ["hsnB2c", "12 · HSN summary — B2C", "Sales to unregistered customers"],
];

// Where each kind of document opens.
const docPath = (r) =>
  ({ credit: `/credit-notes/${r.id}`, bill: `/bills/${r.id}`, expense: `/expenses/${r.id}/edit`, vendorCredit: `/vendor-credits/${r.id}` })[r.kind] || `/invoices/${r.id}`;
function DocLink({ r }) {
  return <Link to={docPath(r)} onClick={(e) => e.stopPropagation()}>{r.number}</Link>;
}

// What's open on the page lives in the address (?sec=…&grp=…), so Back / Esc from a document returns to it.
function useOpen(key) {
  const [sp, setSp] = useSearchParams();
  const val = sp.get(key) || "";
  const set = (v) => {
    const n = new URLSearchParams(sp);
    if (v === "" || v === -1 || v == null) n.delete(key);
    else n.set(key, String(v));
    if (key === "sec") n.delete("grp");
    setSp(n, { replace: true });
  };
  return [val, set];
}

// A list of documents: click a row to open the document (Esc brings you back here).
function DocsTable({ docs, party = "Customer", qty = false }) {
  const navigate = useNavigate();
  if (!docs?.length) return <p className="muted small pad">No documents.</p>;
  const tot = (f) => docs.reduce((t, d) => t + (Number(d[f]) || 0), 0);
  return (
    <table className="table sub-table">
      <thead>
        <tr>
          <th>Number</th>
          <th>Date</th>
          <th>{party}</th>
          {qty ? <th className="num">Qty</th> : <th className="num">Value</th>}
          <th className="num">Taxable</th>
          <th className="num">IGST</th>
          <th className="num">CGST</th>
          <th className="num">SGST</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((r, n) => (
          <tr key={n} className="clickable" onClick={() => navigate(docPath(r))} title="Open">
            <td data-label="Number">
              <DocLink r={r} />
              {r.kind === "credit" && <span className="muted small"> · credit note</span>}
              {r.kind === "vendorCredit" && <span className="muted small"> · vendor credit</span>}
              {r.kind === "expense" && <span className="muted small"> · expense</span>}
            </td>
            <td data-label="Date">{date(r.date)}</td>
            <td data-label={party}>
              {r.name}
              {r.gstin && <div className="muted small">{r.gstin}</div>}
              {r.invoice && <div className="muted small">Against {r.invoice}</div>}
            </td>
            <td data-label={qty ? "Qty" : "Value"} className="num">{qty ? r.qty : <Amt v={r.value} />}</td>
            <td data-label="Taxable" className="num"><Amt v={r.txval} /></td>
            <td data-label="IGST" className="num"><Amt v={r.iamt} /></td>
            <td data-label="CGST" className="num"><Amt v={r.camt} /></td>
            <td data-label="SGST" className="num"><Amt v={r.samt} /></td>
          </tr>
        ))}
        <tr className="total-row">
          <td colSpan={3}>{docs.length} document{docs.length > 1 ? "s" : ""}</td>
          <td className="num">{qty ? Math.round(tot("qty") * 100) / 100 : <Amt v={tot("value")} />}</td>
          <td className="num"><Amt v={tot("txval")} /></td>
          <td className="num"><Amt v={tot("iamt")} /></td>
          <td className="num"><Amt v={tot("camt")} /></td>
          <td className="num"><Amt v={tot("samt")} /></td>
        </tr>
      </tbody>
    </table>
  );
}

// The documents behind one GSTR-1 section, shown right under its row (like Tally's drill-down).
function SectionDetail({ k, rows, docs }) {
  const [g, setGrpRaw] = useOpen("grp");
  const grp = g === "" ? -1 : Number(g);
  const setGrp = (n) => setGrpRaw(n === -1 ? "" : n);
  if (k === "docs")
    return (
      <table className="table sub-table">
        <thead>
          <tr>
            <th>Nature of document</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Total issued</th>
            <th className="num">Cancelled</th>
            <th className="num">Net issued</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>
              <td data-label="Nature">
                {r.nature}
                {r.missing?.length > 0 && (
                  <details className="small muted" onClick={(e) => e.stopPropagation()}>
                    <summary>{r.missing.length} number(s) skipped in this range — why</summary>
                    <ul className="issue-list">
                      {r.missing.slice(0, 50).map((m, j) => (
                        <li key={j}>
                          {m.id ? <DocLink r={{ ...m, kind: r.nature.startsWith("Credit") ? "credit" : "invoice" }} /> : <strong>{m.number}</strong>} — {m.why}
                        </li>
                      ))}
                      {r.missing.length > 50 && <li>…and {r.missing.length - 50} more</li>}
                    </ul>
                  </details>
                )}
              </td>
              <td data-label="From">{r.from}</td>
              <td data-label="To">{r.to}</td>
              <td data-label="Total" className="num">{r.totnum}</td>
              <td data-label="Cancelled" className="num">{r.cancel}</td>
              <td data-label="Net" className="num">{r.net_issue}</td>
            </tr>
          ))}
          <tr className="total-row">
            <td colSpan={3}>Total</td>
            <td className="num">{docs.totnum}</td>
            <td className="num">{docs.cancel}</td>
            <td className="num">{docs.net_issue}</td>
          </tr>
        </tbody>
      </table>
    );
  const navigate = useNavigate();
  const taxCols = (r) => (
    <>
      <td data-label="Taxable" className="num"><Amt v={r.txval ?? r.nil_amt} /></td>
      {k !== "nil" && (
        <>
          <td data-label="IGST" className="num"><Amt v={r.iamt} /></td>
          <td data-label="CGST" className="num"><Amt v={r.camt} /></td>
          <td data-label="SGST" className="num"><Amt v={r.samt} /></td>
        </>
      )}
    </>
  );
  const docRow = (r, n, kind) => (
    <tr key={n} className="clickable" onClick={() => navigate(docPath({ ...r, kind: r.kind || kind }))} title="Open">
      <td data-label="Number"><DocLink r={{ ...r, kind: r.kind || kind }} /></td>
      <td data-label="Date">{date(r.date)}</td>
      <td data-label="Customer">
        {r.name}
        {r.gstin && <div className="muted small">{r.gstin}</div>}
        {r.invoice && <div className="muted small">Against {r.invoice}</div>}
      </td>
      <td data-label="Value" className="num"><Amt v={r.value} /></td>
      {taxCols(r)}
    </tr>
  );
  const docHead = (
    <tr>
      <th>Number</th>
      <th>Date</th>
      <th>Customer</th>
      <th className="num">Invoice value</th>
      <th className="num">Taxable</th>
      <th className="num">IGST</th>
      <th className="num">CGST</th>
      <th className="num">SGST</th>
    </tr>
  );
  if (k === "b2cs")
    return (
      <table className="table sub-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Place of supply</th>
            <th className="num">Rate</th>
            <th className="num">Documents</th>
            <th className="num">Taxable</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => [
            <tr key={n} className="clickable" onClick={() => setGrp(grp === n ? -1 : n)}>
              <td data-label="Type">{grp === n ? "▾" : "▸"} {r.type}</td>
              <td data-label="Place of supply">{stateName(r.pos)}</td>
              <td data-label="Rate" className="num">{r.rate}%</td>
              <td data-label="Documents" className="num">{r.docs?.length || 0}</td>
              {taxCols(r)}
            </tr>,
            grp === n && (
              <tr key={`${n}d`} className="detail-row">
                <td colSpan={8}>
                  <table className="table sub-table">
                    <thead>{docHead}</thead>
                    <tbody>{(r.docs || []).map((x, j) => docRow(x, j))}</tbody>
                  </table>
                </td>
              </tr>
            ),
          ])}
        </tbody>
      </table>
    );
  if (k.startsWith("hsn") || k === "nil")
    return (
      <table className="table sub-table">
        <thead>
          <tr>
            {k.startsWith("hsn") ? (
              <>
                <th>HSN/SAC</th>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Rate</th>
              </>
            ) : (
              <th>Supply type</th>
            )}
            <th className="num">Taxable</th>
            {k !== "nil" && (
              <>
                <th className="num">IGST</th>
                <th className="num">CGST</th>
                <th className="num">SGST</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => [
            <tr key={n} className="clickable" onClick={() => setGrp(grp === n ? -1 : n)} title="Show the documents">
              {k.startsWith("hsn") ? (
                <>
                  <td data-label="HSN/SAC">
                    {grp === n ? "▾ " : "▸ "}
                    {r.hsn_sc || <span className="red">missing</span>}
                  </td>
                  <td data-label="Description">{r.desc}</td>
                  <td data-label="Qty" className="num">
                    {r.qty} {r.uqc}
                  </td>
                  <td data-label="Rate" className="num">{r.rt}%</td>
                </>
              ) : (
                <td data-label="Supply type">
                  {grp === n ? "▾ " : "▸ "}
                  {r.sply_ty}
                </td>
              )}
              {taxCols(r)}
            </tr>,
            grp === n && (
              <tr key={`${n}d`} className="detail-row">
                <td colSpan={8}>
                  <DocsTable docs={r.docs} qty={k.startsWith("hsn")} />
                </td>
              </tr>
            ),
          ])}
        </tbody>
      </table>
    );
  return (
    <table className="table sub-table">
      <thead>{docHead}</thead>
      <tbody>{rows.map((r, n) => docRow(r, n, k.startsWith("cdn") ? "credit" : "invoice"))}</tbody>
    </table>
  );
}

function Gstr1({ period, canEdit }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useOpen("sec");
  const load = () => {
    setD(null);
    api.get("/gst/returns/gstr1", { params: { period } }).then((r) => setD(r.data)).catch((e) => toast(errMsg(e), "error"));
  };
  useEffect(() => {
    load();
  }, [period]);
  if (!d) return <Spinner />;
  const sections = [...SECTIONS, ...(d.summary.docs ? [["docs", "13 · Documents issued", `${d.summary.docs.totnum} issued · ${d.summary.docs.cancel} cancelled · ${d.summary.docs.net_issue} net — by number series`]] : [])];
  return (
    <>
      <div className="ret-head">
        <div>
          <h3>GSTR-1 · {d.period}</h3>
          <p className="muted small">
            {d.documents.invoices} invoices · {d.documents.creditNotes} credit notes{d.documents.cancelled ? ` · ${d.documents.cancelled} cancelled` : ""} · return period {d.fp}
          </p>
        </div>
        <div className="ret-actions">
          <FiledBox form="GSTR-1" period={period} filing={d.filing} onDone={load} summary={d.summary} canEdit={canEdit} />
          <button className="btn btn-primary" onClick={() => download("/gst/returns/gstr1", { period, download: 1 }, `GSTR1_${d.fp}.json`)} title="One JSON file with every section">
            Download JSON
          </button>
          <button className="btn" onClick={() => download("/gst/returns/gstr1", { period, download: 1, split: 1 }, `GSTR1_${d.fp}.zip`)} title="One JSON file per section (B2B, B2CS, CDNR, HSN, documents…) in a zip, as Tally makes them">
            JSON per section (zip)
          </button>
        </div>
      </div>
      <Issues list={d.issues} />
      {d.notes?.length > 0 && (
        <div className="alert alert-info" style={{ marginTop: 10 }}>
          <strong>For your information (no action needed to file)</strong>
          <ul className="issue-list">
            {d.notes.map((t, n) => (
              <li key={n}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>Click a section to see its documents.</p>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="num">Count</th>
              <th className="num">Taxable value</th>
              <th className="num">IGST</th>
              <th className="num">CGST</th>
              <th className="num">SGST</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(([k, l, hint]) => {
              const s = d.summary[k];
              const rows = d.view?.[k] || [];
              const isOpen = open === k && rows.length > 0;
              return [
                <tr key={k} className={s.count ? "clickable" : ""} onClick={() => s.count && setOpen(open === k ? "" : k)}>
                  <td data-label="Section">
                    <strong>
                      {s.count ? (isOpen ? "▾ " : "▸ ") : ""}
                      {l}
                    </strong>
                    {hint && <div className="muted small">{hint}</div>}
                  </td>
                  <td data-label="Count" className="num">{s.count}</td>
                  {k === "docs" ? (
                    <td colSpan={4} />
                  ) : (
                    <>
                      <td data-label="Taxable" className="num"><Amt v={s.txval} /></td>
                      <td data-label="IGST" className="num"><Amt v={s.iamt} /></td>
                      <td data-label="CGST" className="num"><Amt v={s.camt} /></td>
                      <td data-label="SGST" className="num"><Amt v={s.samt} /></td>
                    </>
                  )}
                </tr>,
                isOpen && (
                  <tr key={`${k}-detail`} className="detail-row">
                    <td colSpan={6}>
                      <SectionDetail k={k} rows={rows} docs={d.summary.docs} />
                    </td>
                  </tr>
                ),
              ];
            })}
            <tr className="total-row">
              <td>Tax liability (net of credit notes)</td>
              <td />
              <td className="num"><Amt v={d.liability.txval} /></td>
              <td className="num"><Amt v={d.liability.iamt} /></td>
              <td className="num"><Amt v={d.liability.camt} /></td>
              <td className="num"><Amt v={d.liability.samt} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <HowTo form="GSTR-1" />
    </>
  );
}

function HowTo({ form }) {
  return (
    <details className="howto">
      <summary>How to file {form} with this file</summary>
      <ol>
        <li>Log in at gst.gov.in → Services → Returns → Returns Dashboard, and pick the period.</li>
        {form === "GSTR-1" ? (
          <>
            <li>
              Under GSTR-1, choose <em>Prepare offline</em> → <em>Upload</em>, and upload the JSON downloaded here. Wait for the status to show “Processed”.
            </li>
            <li>Open <em>Prepare online</em>, check the summary matches the figures above, then <em>Generate summary</em> → <em>File with DSC/EVC</em>.</li>
          </>
        ) : (
          <>
            <li>Under GSTR-3B, choose <em>Prepare offline</em> and upload the JSON (or type the figures above into <em>Prepare online</em>).</li>
            <li>Compare the ITC with the auto-filled GSTR-2B figures (use GSTR-2B Reconciliation first), then <em>Proceed to payment</em>, pay the cash amount and file with DSC/EVC.</li>
          </>
        )}
        <li>Copy the ARN back here with “Mark as filed” so the compliance calendar stays up to date.</li>
      </ol>
      <p className="muted small">
        Filing directly from OrdexaGo would need a GST Suvidha Provider (GSP) licence; until then the portal upload above is the official route and takes a minute.
      </p>
    </details>
  );
}

function Gstr3b({ period, canEdit }) {
  const [d, setD] = useState(null);
  const [sec, setSec] = useOpen("sec");
  const [itc, setItc] = useState("books");
  const load = () => {
    setD(null);
    api.get("/gst/returns/gstr3b", { params: { period, itc } }).then((r) => setD(r.data)).catch((e) => toast(errMsg(e), "error"));
  };
  useEffect(() => {
    load();
  }, [period, itc]);
  if (!d) return <Spinner />;
  const dd = d.docs || {};
  const row = (l, v, hint, key, docs, party) => [
    <tr key={key || l} className={docs?.length ? "clickable" : ""} onClick={() => docs?.length && setSec(sec === key ? "" : key)} title={docs?.length ? "Show the documents" : ""}>
      <td data-label="">
        {docs?.length ? (sec === key ? "▾ " : "▸ ") : ""}
        {l}
        {hint && <div className="muted small">{hint}</div>}
      </td>
      <td data-label="Taxable" className="num">{v.txval !== undefined ? <Amt v={v.txval} /> : ""}</td>
      <td data-label="IGST" className="num">{v.iamt !== undefined ? <Amt v={v.iamt} /> : ""}</td>
      <td data-label="CGST" className="num">{v.camt !== undefined ? <Amt v={v.camt} /> : ""}</td>
      <td data-label="SGST" className="num">{v.samt !== undefined ? <Amt v={v.samt} /> : ""}</td>
    </tr>,
    sec === key && docs?.length > 0 && (
      <tr key={`${key}-d`} className="detail-row">
        <td colSpan={5}>
          <DocsTable docs={docs} party={party} />
        </td>
      </tr>
    ),
  ];
  const so = d.setoff;
  return (
    <>
      <div className="ret-head">
        <div>
          <h3>GSTR-3B · {d.period}</h3>
          <p className="muted small">Summary return and tax payment · return period {d.fp}</p>
        </div>
        <div className="ret-actions">
          <FiledBox form="GSTR-3B" period={period} filing={d.filing} onDone={load} summary={{ liability: d.liability, cash: so.cash }} canEdit={canEdit} />
          <button className="btn btn-primary" onClick={() => download("/gst/returns/gstr3b", { period, itc, download: 1 }, `GSTR3B_${d.fp}.json`)}>
            Download JSON
          </button>
        </div>
      </div>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>3.1 · Outward supplies</th>
              <th className="num">Taxable value</th>
              <th className="num">IGST</th>
              <th className="num">CGST</th>
              <th className="num">SGST</th>
            </tr>
          </thead>
          <tbody>
            {row("(a) Taxable outward supplies", d.outward, "Net of credit notes", "outward", dd.outward)}
            {row("(b) Zero-rated (exports)", d.zeroRated, "", "zero", dd.zeroRated)}
            {row("(c) Nil rated / exempt", { txval: d.nil }, "", "nil", dd.nil)}
          </tbody>
        </table>
      </div>
      {d.unreg.length > 0 && (
        <div className="card flush" style={{ marginTop: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>3.2 · Inter-state supplies to unregistered persons</th>
                <th className="num">Taxable value</th>
                <th className="num">IGST</th>
              </tr>
            </thead>
            <tbody>
              {d.unreg.map((u) => [
                <tr key={u.pos} className="clickable" onClick={() => setSec(sec === `pos${u.pos}` ? "" : `pos${u.pos}`)} title="Show the documents">
                  <td>
                    {sec === `pos${u.pos}` ? "▾ " : "▸ "}
                    {stateName(u.pos)}
                  </td>
                  <td className="num"><Amt v={u.txval} /></td>
                  <td className="num"><Amt v={u.iamt} /></td>
                </tr>,
                sec === `pos${u.pos}` && (
                  <tr key={`${u.pos}-d`} className="detail-row">
                    <td colSpan={3}>
                      <DocsTable docs={dd.unreg?.[u.pos]} />
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
      <div className="card flush" style={{ marginTop: 14 }}>
        <div className="card-head pad-x">
          <strong>4 · Eligible ITC</strong>
          <div className="seg">
            <button className={itc === "books" ? "on" : ""} onClick={() => setItc("books")}>
              From books
            </button>
            <button className={itc === "2b" ? "on" : ""} disabled={!d.itc2bAvailable} title={d.itc2bAvailable ? "" : "Upload GSTR-2B under Reconciliation first"} onClick={() => setItc("2b")}>
              As per GSTR-2B
            </button>
          </div>
        </div>
        {/* Table 4 as on the portal: its own columns (no taxable value). */}
        <table className="table">
          <thead>
            <tr>
              <th>Details</th>
              <th className="num">Integrated tax</th>
              <th className="num">Central tax</th>
              <th className="num">State/UT tax</th>
              <th className="num">Cess</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const z = { iamt: 0, camt: 0, samt: 0 };
              const line = (label, v, opts = {}) => [
                <tr key={label} className={`${opts.docs?.length ? "clickable" : ""} ${opts.total ? "total-row" : ""}`} onClick={() => opts.docs?.length && setSec(sec === opts.k ? "" : opts.k)} title={opts.docs?.length ? "Show the documents" : ""}>
                  <td style={{ paddingLeft: opts.indent ? 28 : undefined }}>
                    {opts.docs?.length ? (sec === opts.k ? "▾ " : "▸ ") : ""}
                    {label}
                    {opts.hint && <div className="muted small">{opts.hint}</div>}
                  </td>
                  <td className="num">{opts.head ? "" : <Amt v={v.iamt} />}</td>
                  <td className="num">{opts.head ? "" : <Amt v={v.camt} />}</td>
                  <td className="num">{opts.head ? "" : <Amt v={v.samt} />}</td>
                  <td className="num">{opts.head ? "" : <Amt v={0} />}</td>
                </tr>,
                opts.docs?.length > 0 && sec === opts.k && (
                  <tr key={`${label}-d`} className="detail-row">
                    <td colSpan={5}>
                      <DocsTable docs={opts.docs} party="Vendor" />
                    </td>
                  </tr>
                ),
              ];
              return [
                line("(A) ITC Available (whether in full or part)", z, { head: true }),
                line("(1) Import of goods", z, { indent: true }),
                line("(2) Import of services", z, { indent: true }),
                line("(3) Inward supplies liable to reverse charge (other than 1 & 2 above)", z, { indent: true }),
                line("(4) Inward supplies from ISD", z, { indent: true }),
                line("(5) All other ITC", d.itc, { indent: true, hint: d.itcSource === "2b" ? "As per GSTR-2B" : "As per books: bills and expenses with GST, less vendor credits", docs: d.itcSource === "2b" ? null : [...(dd.itcBooks || []), ...(dd.itcReversed || []).map((x) => ({ ...x, value: -x.value, txval: -x.txval, iamt: -x.iamt, camt: -x.camt, samt: -x.samt }))], k: "itc" }),
                line("(B) ITC Reversed", z, { head: true }),
                line("(1) As per rules 38, 42 & 43 of CGST Rules and section 17(5)", z, { indent: true }),
                line("(2) Others", z, { indent: true }),
                line("(C) Net ITC available (A) – (B)", d.itc, { total: true }),
                line("(D) Other details", z, { head: true }),
                line("(1) ITC reclaimed which was reversed under Table 4(B)(2) in earlier tax period", z, { indent: true }),
                line("(2) Ineligible ITC under section 16(4) & ITC restricted due to PoS rules", z, { indent: true }),
              ];
            })()}
          </tbody>
        </table>
        {d.itc2bAvailable && (
          <p className="muted small pad">
            Books: ITC on bills and expenses {money((d.itcBooks.iamt || 0) + (d.itcBooks.camt || 0) + (d.itcBooks.samt || 0))}, less vendor credits {money((d.itcReversed.iamt || 0) + (d.itcReversed.camt || 0) + (d.itcReversed.samt || 0))} · GSTR-2B: {money((d.itc2bAvailable.iamt || 0) + (d.itc2bAvailable.camt || 0) + (d.itc2bAvailable.samt || 0))}
          </p>
        )}
      </div>
      <div className="card flush" style={{ marginTop: 14 }}>
        <table className="table">
          <thead>
            <tr>
              <th>5 · Values of exempt, nil-rated and non-GST inward supplies</th>
              <th className="num">Inter-State supplies</th>
              <th className="num">Intra-State supplies</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["From a supplier under composition scheme, Exempt and Nil rated supply", d.inwardNil, "inNil", dd.inwardNil],
              ["Non GST supply", d.inwardNonGst || { inter: 0, intra: 0 }, "inNon", dd.inwardNonGst],
            ].map(([label, v, k, docs]) => [
              <tr key={k} className={docs?.length ? "clickable" : ""} onClick={() => docs?.length && setSec(sec === k ? "" : k)} title={docs?.length ? "Show the documents" : ""}>
                <td>
                  {docs?.length ? (sec === k ? "▾ " : "▸ ") : ""}
                  {label}
                  {k === "inNon" && <div className="muted small">Purchases from unregistered suppliers (no GSTIN), and ledgers marked "Non-GST supply" in Chart of Accounts</div>}
                  {k === "inNil" && <div className="muted small">0% GST lines on bills and expenses of registered suppliers</div>}
                </td>
                <td className="num"><Amt v={v.inter} /></td>
                <td className="num"><Amt v={v.intra} /></td>
              </tr>,
              sec === k && docs?.length > 0 && (
                <tr key={`${k}-d`} className="detail-row">
                  <td colSpan={3}>
                    <DocsTable docs={docs} party="Vendor" />
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      </div>
      <div className="card flush" style={{ marginTop: 14 }}>
        <table className="table">
          <thead>
            <tr>
              <th>6.1 · Payment of tax</th>
              <th className="num">Liability</th>
              <th className="num">Paid by IGST credit</th>
              <th className="num">Paid by CGST credit</th>
              <th className="num">Paid by SGST credit</th>
              <th className="num">Pay in cash</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Integrated tax</td>
              <td className="num"><Amt v={d.liability.iamt} /></td>
              <td className="num"><Amt v={so.used.ii} /></td>
              <td className="num"><Amt v={so.used.ci} /></td>
              <td className="num"><Amt v={so.used.si} /></td>
              <td className="num"><Amt v={so.cash.iamt} /></td>
            </tr>
            <tr>
              <td>Central tax</td>
              <td className="num"><Amt v={d.liability.camt} /></td>
              <td className="num"><Amt v={so.used.ic} /></td>
              <td className="num"><Amt v={so.used.cc} /></td>
              <td className="num">—</td>
              <td className="num"><Amt v={so.cash.camt} /></td>
            </tr>
            <tr>
              <td>State/UT tax</td>
              <td className="num"><Amt v={d.liability.samt} /></td>
              <td className="num"><Amt v={so.used.is} /></td>
              <td className="num">—</td>
              <td className="num"><Amt v={so.used.ss} /></td>
              <td className="num"><Amt v={so.cash.samt} /></td>
            </tr>
            <tr className="total-row">
              <td>Total cash to pay</td>
              <td colSpan={4} className="muted small">
                Credit carried forward: IGST {money(so.carryForward.iamt)} · CGST {money(so.carryForward.camt)} · SGST {money(so.carryForward.samt)}
              </td>
              <td className="num">
                <strong>{money(so.cash.total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Credit is used as the law requires: IGST credit first, then CGST and SGST credit; CGST and SGST credit are never used against each other. Interest and late fee, if any, are added by the portal.
      </p>
      {d.issues.length > 0 && <Issues list={d.issues} />}
      <HowTo form="GSTR-3B" />
    </>
  );
}

function Gstr9({ canEdit }) {
  const [fy, setFy] = useState(() => {
    const y = +currentFy().slice(0, 4) - 1;
    return `${y}-${String(y + 1).slice(2)}`;
  });
  const [d, setD] = useState(null);
  const load = () => {
    setD(null);
    api.get("/gst/returns/gstr9", { params: { fy } }).then((r) => setD(r.data)).catch((e) => toast(errMsg(e), "error"));
  };
  useEffect(() => {
    load();
  }, [fy]);
  const block = (title, obj, cols = ["txval", "iamt", "camt", "samt"]) => (
    <div className="card flush" style={{ marginTop: 14 }}>
      <table className="table">
        <thead>
          <tr>
            <th>{title}</th>
            {cols.map((c) => (
              <th key={c} className="num">
                {{ txval: "Taxable value", iamt: "IGST", camt: "CGST", samt: "SGST" }[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(obj).map(([k, v]) => (
            <tr key={k} className={/Total|Net/.test(k) ? "total-row" : ""}>
              <td>{k}</td>
              {cols.map((c) => (
                <td key={c} className="num">{v[c] !== undefined ? <Amt v={v[c]} /> : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <div className="ret-head">
        <div>
          <h3>GSTR-9 · Annual return</h3>
          <p className="muted small">Working figures from the books for the year, to fill the portal's GSTR-9 tables. Due 31 December after the year ends.</p>
        </div>
        <div className="ret-actions">
          <select className="select-inline" value={fy} onChange={(e) => setFy(e.target.value)}>
            {fyOptions().map((f) => (
              <option key={f} value={f}>
                FY {f}
              </option>
            ))}
          </select>
          {d && <FiledBox form="GSTR-9" period={d.fy} filing={d.filing} onDone={load} canEdit={canEdit} />}
          <button className="btn btn-primary" onClick={() => download("/gst/returns/gstr9", { fy, download: "xlsx" }, `GSTR9_${fy}.xlsx`)}>
            Download Excel
          </button>
        </div>
      </div>
      {!d ? (
        <Spinner />
      ) : (
        <>
          <p className="muted small">
            {d.counts.invoices} invoices · {d.counts.creditNotes} credit notes · {d.counts.bills} bills · {d.counts.expenses} expenses
          </p>
          {block("Table 4 · Outward supplies with tax", d.table4)}
          {block("Table 5 · Supplies without tax", d.table5, ["txval"])}
          {block("Tables 6–7 · Input tax credit", d.table6, ["iamt", "camt", "samt"])}
          {block("Table 9 · Tax payable and paid in cash", { "Tax payable": d.table9.payable, "Paid in cash": d.table9.paidThroughItc.cash }, ["iamt", "camt", "samt"])}
          <p className="muted small" style={{ marginTop: 8 }}>
            HSN-wise outward (Table 17: {d.table17.length} rows) and inward (Table 18: {d.table18.length} rows) summaries are in the Excel download. GSTR-9C (turnover above ₹5 crore) is self-certified on the portal using these same figures.
          </p>
        </>
      )}
    </>
  );
}

const KIND = { gst: "GST", tds: "TDS", income: "Income tax" };
function Calendar({ canEdit, onOpen }) {
  const [fy, setFy] = useState(currentFy());
  const [d, setD] = useState(null);
  const [show, setShow] = useState("open");
  const load = () => api.get("/gst/returns/calendar", { params: { fy } }).then((r) => setD(r.data));
  useEffect(() => {
    setD(null);
    load();
  }, [fy]);
  if (!d) return <Spinner />;
  const items = d.items.filter((i) => (show === "open" ? !["filed", "optional"].includes(i.status) : true));
  const counts = { overdue: d.items.filter((i) => i.status === "overdue").length, due_soon: d.items.filter((i) => i.status === "due_soon").length, filed: d.items.filter((i) => i.status === "filed").length };
  const pill = { filed: "pill-green", overdue: "pill-red", due_soon: "pill-amber", upcoming: "", optional: "" };
  const words = { filed: "Filed", overdue: "Overdue", due_soon: "Due soon", upcoming: "Upcoming", optional: "Optional" };
  return (
    <>
      <div className="ret-head">
        <div className="kpis no-border">
          <div>
            <span className="muted small">Overdue</span>
            <strong className={counts.overdue ? "red" : ""}>{counts.overdue}</strong>
          </div>
          <div>
            <span className="muted small">Due in 7 days</span>
            <strong>{counts.due_soon}</strong>
          </div>
          <div>
            <span className="muted small">Filed this year</span>
            <strong>{counts.filed}</strong>
          </div>
        </div>
        <div className="ret-actions">
          <select className="select-inline" value={fy} onChange={(e) => setFy(e.target.value)}>
            {fyOptions().map((f) => (
              <option key={f} value={f}>
                FY {f}
              </option>
            ))}
          </select>
          <div className="seg">
            <button className={show === "open" ? "on" : ""} onClick={() => setShow("open")}>
              To do
            </button>
            <button className={show === "all" ? "on" : ""} onClick={() => setShow("all")}>
              All
            </button>
          </div>
        </div>
      </div>
      {!d.gstin && <div className="alert alert-warn">Add your GSTIN in Settings → Organization so the returns carry it.</div>}
      <div className="card flush" style={{ marginTop: 12 }}>
        <table className="table cal-table">
          <thead>
            <tr>
              <th>Due date</th>
              <th>Return</th>
              <th>Period</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.form}|${i.period}`}>
                <td data-label="Due">{date(i.due)}</td>
                <td data-label="Return">
                  <strong>{i.form}</strong> <span className="badge">{KIND[i.kind]}</span>
                  {i.note && <div className="muted small">{i.note}</div>}
                </td>
                <td data-label="Period">{i.label}</td>
                <td data-label="Status">
                  <span className={`pill ${pill[i.status]}`}>{words[i.status]}</span>
                  {i.filing?.arn && <div className="muted small">ARN {i.filing.arn}</div>}
                </td>
                <td className="num">
                  {["GSTR-1", "GSTR-3B"].includes(i.form) ? (
                    <button className="btn btn-sm" onClick={() => onOpen(i.form === "GSTR-1" ? "gstr1" : "gstr3b", i.period)}>
                      Prepare
                    </button>
                  ) : i.form === "GSTR-9" ? (
                    <button className="btn btn-sm" onClick={() => onOpen("gstr9")}>
                      Prepare
                    </button>
                  ) : (
                    !i.filing && canEdit && <QuickFile item={i} onDone={load} />
                  )}
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing pending for FY {fy}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function QuickFile({ item, onDone }) {
  const mark = async () => {
    const ref = window.prompt(`Mark ${item.form} (${item.label}) as done. Challan / acknowledgement number (optional):`, "");
    if (ref === null) return;
    try {
      await api.post("/gst/returns/filings", { form: item.form, period: item.period, arn: ref, filedOn: isoDate() });
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <button className="btn btn-sm" onClick={mark}>
      Mark done
    </button>
  );
}

export function GstReturns() {
  const { user, organization, setOrganization } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") || "calendar";
  const period = sp.get("period") || lastMonth();
  const put = (k, v) => {
    const n = new URLSearchParams(sp);
    n.set(k, v);
    n.delete("sec");
    n.delete("grp");
    setSp(n, { replace: true });
  };
  const setTab = (t) => put("tab", t);
  const setPeriod = (p) => put("period", p);
  const [freq, setFreq] = useState(organization?.gstFiling?.frequency || "monthly");
  const canEdit = can(user, "gst", "full");
  const open = (t, p) => {
    const n = new URLSearchParams(sp);
    n.set("tab", t);
    if (p) n.set("period", p);
    n.delete("sec");
    n.delete("grp");
    setSp(n, { replace: true });
  };
  const saveFreq = async (v) => {
    try {
      await api.put("/gst/returns/frequency", { frequency: v });
      setFreq(v);
      setOrganization?.({ ...organization, gstFiling: { frequency: v } });
      toast(v === "quarterly" ? "Filing quarterly (QRMP)" : "Filing monthly");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <PageHeader title="GST Returns" subtitle={`${organization?.gstin || "No GSTIN yet"} · ${stateName(organization?.state)}`}>
        {["gstr1", "gstr3b"].includes(tab) && <input type="month" className="select-inline" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />}
        <select className="select-inline" value={freq} disabled={!canEdit} onChange={(e) => saveFreq(e.target.value)} title="How often you file GSTR-1 and GSTR-3B">
          <option value="monthly">Monthly filer</option>
          <option value="quarterly">Quarterly (QRMP)</option>
        </select>
        <Link className="btn" to="/gst/reconcile">
          GSTR-2B Reconciliation
        </Link>
      </PageHeader>
      <div className="tabs">
        {[
          ["calendar", "Compliance calendar"],
          ["gstr1", "GSTR-1"],
          ["gstr3b", "GSTR-3B"],
          ["gstr9", "GSTR-9"],
        ].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "calendar" && <Calendar key={freq} canEdit={canEdit} onOpen={open} />}
      {tab === "gstr1" && <Gstr1 key={freq} period={period} canEdit={canEdit} />}
      {tab === "gstr3b" && <Gstr3b key={freq} period={period} canEdit={canEdit} />}
      {tab === "gstr9" && <Gstr9 canEdit={canEdit} />}
    </>
  );
}
