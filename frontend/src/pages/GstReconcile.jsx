import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, toast } from "../components/ui";
import { can } from "../components/Layout";

const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const readB64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
const tax = (x) => (x ? (x.iamt || 0) + (x.camt || 0) + (x.samt || 0) : 0);
const STATUS = [
  ["matched", "Matched", "pill-green", "In GSTR-2B and in your books with the same figures."],
  ["probable", "Probable match", "pill-amber", "Same supplier and amounts, but the bill number differs. Accept it, or fix the bill number."],
  ["mismatch", "Mismatch", "pill-amber", "Found in both, but the values differ. Check the bill against the supplier's invoice."],
  ["missing_in_books", "Not in books", "pill-red", "The supplier reported it but you haven't recorded the bill. Record it to claim the ITC."],
  ["missing_in_2b", "Not in GSTR-2B", "pill-red", "You recorded the bill but the supplier hasn't reported it. ITC on it can't be claimed yet — follow up with the supplier."],
];
const docLink = (b) => (b.kind === "bill" ? `/bills/${b.id}` : b.kind === "expense" ? `/expenses/${b.id}/edit` : `/vendor-credits/${b.id}`);

export function GstReconcile() {
  const { user } = useAuth();
  const canEdit = can(user, "gst", "full");
  const [period, setPeriod] = useState(lastMonth());
  const [d, setD] = useState(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef();
  const load = () => {
    setD(null);
    api.get("/gst/returns/2b", { params: { period } }).then((r) => setD(r.data)).catch((e) => toast(errMsg(e), "error"));
  };
  useEffect(load, [period]);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { data } = await api.post("/gst/returns/2b", { period, name: file.name, data: await readB64(file) });
      toast(`${data.count} supplier documents loaded for ${data.period}`);
      if (data.period !== period) setPeriod(data.period);
      else load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
    if (input.current) input.current.value = "";
  };
  const accept = async (row, yes = true) => {
    await api.post(`/gst/returns/2b/${period}/accept`, { key: `${row.gstin}|${row.portal.number}`, accept: yes });
    load();
  };
  const remove = async () => {
    if (!window.confirm("Remove this GSTR-2B statement?")) return;
    await api.delete(`/gst/returns/2b/${period}`);
    load();
  };
  const rows = (d?.rows || []).filter((r) => (filter === "all" || r.status === filter) && (!q || `${r.name} ${r.gstin} ${r.portal?.number || ""} ${r.books?.number || ""}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title="GSTR-2B Reconciliation" subtitle="Match the purchases your suppliers reported against your bills, before claiming ITC">
        <input type="month" className="select-inline" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        {canEdit && (
          <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Reading…" : d?.statement ? "Upload again" : "Upload GSTR-2B"}
          </button>
        )}
        <input ref={input} type="file" hidden accept=".json,.xlsx,.xls,application/json" onChange={(e) => upload(e.target.files[0])} />
      </PageHeader>
      {!d ? (
        <Spinner />
      ) : !d.statement ? (
        <div className="card empty-card">
          <h3>No GSTR-2B for {period} yet</h3>
          <p className="muted">
            On gst.gov.in go to Services → Returns → Returns Dashboard → pick the month → GSTR-2B → <em>Download</em> (JSON or Excel), then upload it here. The older GSTR-2A JSON works too.
          </p>
          {d.statements?.length > 0 && (
            <p className="muted small">
              Uploaded so far:{" "}
              {d.statements.map((s) => (
                <button key={s.period} className="link-btn" onClick={() => setPeriod(s.period)}>
                  {s.period}{" "}
                </button>
              ))}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="muted small">
            {d.statement.count} documents from {d.statement.fileName || "upload"} · uploaded {date(d.statement.updatedAt)} by {d.statement.by}
            {canEdit && (
              <>
                {" · "}
                <button className="link-btn small" onClick={remove}>
                  Remove
                </button>
              </>
            )}
          </p>
          <div className="recon-cards">
            {STATUS.map(([k, l, cls]) => (
              <button key={k} className={`recon-card ${filter === k ? "on" : ""}`} onClick={() => setFilter(filter === k ? "all" : k)}>
                <span className={`pill ${cls}`}>{l}</span>
                <strong>{d.summary[k].count}</strong>
                <span className="muted small">ITC {money(tax(k === "missing_in_2b" ? d.summary[k].books : d.summary[k].portal))}</span>
              </button>
            ))}
          </div>
          <div className="recon-itc">
            <div>
              <span className="muted small">ITC in GSTR-2B (available)</span>
              <strong>{money(tax(d.itc2b))}</strong>
            </div>
            <div>
              <span className="muted small">ITC in your books this month</span>
              <strong>{money(tax(d.itcBooks))}</strong>
            </div>
            <div>
              <span className="muted small">Difference</span>
              <strong className={Math.abs(tax(d.itc2b) - tax(d.itcBooks)) > 1 ? "red" : ""}>{money(tax(d.itc2b) - tax(d.itcBooks))}</strong>
            </div>
            <Link className="btn btn-sm" to="/gst">
              Use in GSTR-3B →
            </Link>
          </div>
          {filter !== "all" && <div className="alert alert-info">{STATUS.find((s) => s[0] === filter)[3]}</div>}
          <div className="summary-strip" style={{ marginTop: 10 }}>
            <input className="input-inline" placeholder="Search supplier, GSTIN or number" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="muted small">{rows.length} rows</span>
          </div>
          <div className="card flush">
            <table className="table recon-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>GSTR-2B</th>
                  <th>Your books</th>
                  <th className="num">Tax (2B)</th>
                  <th className="num">Tax (books)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, n) => {
                  const st = STATUS.find((s) => s[0] === r.status);
                  return (
                    <tr key={n}>
                      <td data-label="Supplier">
                        {r.name}
                        <div className="muted small">{r.gstin}</div>
                      </td>
                      <td data-label="GSTR-2B">
                        {r.portal ? (
                          <>
                            {r.portal.number}
                            <div className="muted small">
                              {r.portal.date ? date(r.portal.date) : ""} · {money(r.portal.value)}
                              {r.portal.itc === false ? " · ITC not available" : ""}
                              {r.portal.reverse ? " · reverse charge" : ""}
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="Books">
                        {r.books ? (
                          <>
                            <Link to={docLink(r.books)}>{r.books.number || "(no number)"}</Link>
                            <div className="muted small">
                              {date(r.books.date)} · {money(r.books.value)}
                            </div>
                          </>
                        ) : canEdit && r.portal ? (
                          <Link className="btn btn-sm" to={`/bills/new?number=${encodeURIComponent(r.portal.number)}${r.vendorId ? `&vendor=${r.vendorId}` : ""}`}>
                            Record bill
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="Tax (2B)" className="num">
                        {r.portal ? money(tax(r.portal)) : "—"}
                      </td>
                      <td data-label="Tax (books)" className="num">
                        {r.books ? money(tax(r.books)) : "—"}
                      </td>
                      <td data-label="Status">
                        <span className={`pill ${st[2]}`}>{r.accepted ? "Accepted" : st[1]}</span>
                        {r.diffs.length > 0 && <div className="muted small">{r.diffs.join(", ")} differ</div>}
                        {canEdit && ["mismatch", "probable"].includes(r.status) && (
                          <button className="link-btn small" onClick={() => accept(r)}>
                            Accept
                          </button>
                        )}
                        {canEdit && r.accepted && (
                          <button className="link-btn small" onClick={() => accept(r, false)}>
                            Undo
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
