import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { PageHeader, Field, SearchBox, useDebounced, toast } from "../components/ui";
import { breakdownText } from "../components/rates";

// Fill the weight and size from a package type.
function PackageQuick({ onPick }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api.get("/shopify/package-types", { params: { q: dq || undefined } }).then((r) => setRows(r.data)).catch(() => {});
  }, [dq]);
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div className="label-sm" style={{ margin: 0 }}>
          Use a package type
        </div>
        <SearchBox value={q} onChange={setQ} placeholder="Name, SKU, size…" />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {rows.slice(0, 40).map((p) => (
          <button key={p._id} type="button" className="btn btn-sm" onClick={() => onPick(p)} title={p.products.map((x) => x.sku || x.name).join(", ")}>
            {p.name} · {p.weight} kg · {p.length}×{p.breadth}×{p.height}
          </button>
        ))}
        {!rows.length && <span className="muted small">No package types{q ? " match" : " yet"}.</span>}
      </div>
    </div>
  );
}

// Rate calculator: every active courier for a pincode, weight and size.
export function ShippingCalculator() {
  const [f, setF] = useState({ to: "", weight: "", length: "", breadth: "", height: "", value: "", cod: false });
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, weight: Number(f.weight), length: Number(f.length) || 0, breadth: Number(f.breadth) || 0, height: Number(f.height) || 0, value: Number(f.value) || 0 };
      setR((await api.post("/shopify/couriers/calculate", body)).data);
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  return (
    <>
    <PageHeader title="Shipping Calculator" subtitle="Live serviceability and charges of every active courier for a pincode, weight and size." />
    <form className="card form" onSubmit={go}>
      <div className="row-4">
        <Field label="Destination pincode" required>
          <input value={f.to} onChange={set("to")} maxLength={6} />
        </Field>
        <Field label="Dead weight (kg)" required>
          <input type="number" step="0.01" min="0" value={f.weight} onChange={set("weight")} />
        </Field>
        <Field label="Order value ₹">
          <input type="number" step="0.01" min="0" value={f.value} onChange={set("value")} />
        </Field>
        <label className="check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={f.cod} onChange={set("cod")} /> COD
        </label>
      </div>
      <div className="row-4">
        <Field label="Length (cm)">
          <input type="number" step="0.1" min="0" value={f.length} onChange={set("length")} />
        </Field>
        <Field label="Breadth (cm)">
          <input type="number" step="0.1" min="0" value={f.breadth} onChange={set("breadth")} />
        </Field>
        <Field label="Height (cm)">
          <input type="number" step="0.1" min="0" value={f.height} onChange={set("height")} />
        </Field>
        <button className="btn btn-primary" style={{ alignSelf: "end" }} disabled={busy}>
          {busy ? "Calculating…" : "Calculate"}
        </button>
      </div>
      {r && (
        <>
          <p className="muted small">
            {f.to}: {r.destination?.district ? `${r.destination.district}, ${r.destination.state}` : "location not found"}
          </p>
          <table className="table compact">
            <thead>
              <tr>
                <th>Courier</th>
                <th>Pincode</th>
                <th>Zone · weight</th>
                <th className="num">Total</th>
                <th>Breakdown</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((q) => (
                <tr key={q.account} className={q.serviceable === false ? "muted" : ""}>
                  <td>
                    {q.name}
                    {q.edl && <span className="pill pill-amber" style={{ marginLeft: 6 }}>EDL</span>}
                  </td>
                  <td className="small">{q.serviceable === true ? "Serviceable" : q.serviceable === false ? <span className="text-red">Not serviceable</span> : "Not checked"}{q.note && <div className="muted small">{q.note}</div>}</td>
                  <td className="small">
                    {q.zone || "—"} · {q.chargeableWeight} kg
                  </td>
                  <td className="num">{q.charge != null ? <strong>₹{q.charge}</strong> : "—"} <span className="muted small">{q.source === "api" ? "API" : q.source}</span></td>
                  <td className="small muted" style={{ whiteSpace: "pre-line" }}>
                    {breakdownText(q).split("\n").pop()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </form>
    <PackageQuick onPick={(p) => setF((x) => ({ ...x, weight: p.weight, length: p.length, breadth: p.breadth, height: p.height }))} />
    </>
  );
}

