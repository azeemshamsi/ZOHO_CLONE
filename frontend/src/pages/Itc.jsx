import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader, Spinner, toast } from "../components/ui";

// Input tax credit: books month by month beside GSTR-2B, ITC used / reversed, balance left, ITC at risk.

const fyNow = () => {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};
const HEADS = [
  ["igst", "IGST"],
  ["cgst", "CGST"],
  ["sgst", "SGST"],
  ["cess", "Cess"],
];
const amt = (n) => (n ? money(n) : "—");

export default function Itc() {
  const [fy, setFy] = useState(fyNow());
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api
      .get("/dashboard/itc", { params: { fy } })
      .then((r) => setD(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  }, [fy]);
  const heads = d ? HEADS.filter(([k]) => d.fyTaken[k] || d.balance[k] || d.opening[k]) : [];
  return (
    <>
      <PageHeader title="Input Tax Credit (ITC)" subtitle={d ? `Financial year ${d.fy}` : ""} back="/">
        <select value={fy} onChange={(e) => setFy(Number(e.target.value))} style={{ width: "auto" }}>
          {[0, 1, 2, 3].map((i) => (
            <option key={i} value={fyNow() - i}>
              FY {fyNow() - i}-{String((fyNow() - i + 1) % 100).padStart(2, "0")}
            </option>
          ))}
        </select>
        <Link className="btn" to="/gst/reconcile">
          GSTR-2B reconciliation
        </Link>
      </PageHeader>
      {!d ? (
        <Spinner />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
            <Tile label="ITC available now (balance)" value={money(d.balance.total)} sub={heads.map(([k, l]) => `${l} ${money(d.balance[k])}`).join(" · ")} />
            <Tile label={`ITC taken in FY ${d.fy}`} value={money(d.fyTaken.total)} sub={`Opening ${money(d.opening.total)} · used / reversed ${money(d.fyUsed.total)}`} />
            <Tile
              label={d.lastWith2b ? `${d.lastWith2b.label}: books vs GSTR-2B` : "Books vs GSTR-2B"}
              value={d.lastWith2b ? money(d.lastWith2b.diff) : "No 2B uploaded"}
              sub={d.lastWith2b ? `Books ${money(d.lastWith2b.books)} · 2B ${money(d.lastWith2b.b2b)}${d.lastWith2b.diff > 0.99 ? " — more in books than 2B: check before claiming" : ""}` : "Upload GSTR-2B under GST → Reconcile GSTR-2B"}
              alert={d.lastWith2b && d.lastWith2b.diff > 0.99}
            />
            <Tile
              label="ITC at risk (bills unpaid > 180 days)"
              value={money(d.risk180?.itc || 0)}
              sub={d.risk180 ? `${d.risk180.count} bills over 180 days · ${d.risk180.soonCount} reaching it (${money(d.risk180.soonItc)})` : ""}
              alert={!!d.risk180?.itc}
              to="/reports/bills-180-days"
            />
          </div>

          <div className="card flush" style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Month</th>
                  {heads.map(([, l]) => (
                    <th key={l} className="num">
                      {l}
                    </th>
                  ))}
                  <th className="num">ITC taken (books)</th>
                  <th className="num">As per GSTR-2B</th>
                  <th className="num">Difference</th>
                  <th className="num">Used / reversed</th>
                </tr>
              </thead>
              <tbody>
                <tr className="row-muted">
                  <td>Opening balance</td>
                  {heads.map(([k]) => (
                    <td key={k} className="num">
                      {amt(d.opening[k])}
                    </td>
                  ))}
                  <td className="num">{money(d.opening.total)}</td>
                  <td colSpan={3} />
                </tr>
                {d.months.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    {heads.map(([k]) => (
                      <td key={k} className="num">
                        {amt(m.taken[k])}
                      </td>
                    ))}
                    <td className="num strong">{amt(m.taken.total)}</td>
                    <td className="num">{m.b2b ? money(m.b2b.total) : <span className="muted small">not uploaded</span>}</td>
                    <td className="num" style={m.diff > 0.99 ? { color: "var(--red)" } : undefined}>
                      {m.diff === null ? "" : money(m.diff)}
                    </td>
                    <td className="num">{amt(m.used.total)}</td>
                  </tr>
                ))}
                <tr className="row-total">
                  <td>Total {d.fy}</td>
                  {heads.map(([k]) => (
                    <td key={k} className="num">
                      {money(d.fyTaken[k])}
                    </td>
                  ))}
                  <td className="num">{money(d.fyTaken.total)}</td>
                  <td className="num">{money(d.months.reduce((t, m) => t + (m.b2b?.total || 0), 0))}</td>
                  <td />
                  <td className="num">{money(d.fyUsed.total)}</td>
                </tr>
                <tr className="row-total">
                  <td>Balance (ITC available)</td>
                  {heads.map(([k]) => (
                    <td key={k} className="num">
                      {money(d.balance[k])}
                    </td>
                  ))}
                  <td className="num">{money(d.balance.total)}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            Books: ITC on purchase bills and expenses (less vendor credits) in {d.ledgers.map((l) => l.name).join(", ") || "the Input GST ledgers"}; journals that debit them count as taken, journals that credit them (GSTR-3B set-off, reversals) as used. GSTR-2B: lines marked ITC available in the uploaded 2B. A positive difference means more ITC in the books than in 2B — under Section 16(2)(aa) only what's in 2B can be claimed.
          </p>
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub, alert, to }) {
  const body = (
    <div className="card" style={{ padding: 14, height: "100%", borderLeft: alert ? "4px solid var(--red)" : undefined }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div className="small muted" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
  return to ? (
    <Link to={to} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    body
  );
}
