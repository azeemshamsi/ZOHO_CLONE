import { useEffect, useMemo, useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money } from "../lib/format";
import { PageHeader, Spinner, toast } from "../components/ui";

/**
 * Zakat valuation — private to admins. Each item's zakat cost (separate from the accounting cost, posts nothing)
 * × stock on hand on the chosen date, and zakat at 2.5%. Not on any menu or dashboard: Settings → Zakat valuation.
 */
const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

function CostCell({ row, onSaved }) {
  const [v, setV] = useState(null);
  const save = async () => {
    const n = Math.max(0, Number(v) || 0);
    setV(null);
    if (n === row.zakatCost) return;
    try {
      await api.put(`/zakat/${row._id}`, { zakatCost: n });
      onSaved(row._id, n);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  if (v !== null)
    return (
      <input
        type="number"
        min="0"
        step="any"
        autoFocus
        value={v}
        style={{ width: 110, textAlign: "right" }}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") setV(null);
        }}
      />
    );
  return (
    <button type="button" className="link-btn" onClick={() => setV(String(row.zakatCost || ""))}>
      {row.zakatCost ? money(row.zakatCost) : "Add"}
    </button>
  );
}

// "SKU,Zakat cost" lines (header optional) → rows.
const parseCsv = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, "")))
    .filter((c) => c[0] && c[1] !== undefined && !Number.isNaN(Number(String(c[1]).replace(/[₹,\s]/g, ""))) && String(c[1]).trim() !== "")
    .map((c) => ({ sku: c[0], zakatCost: Number(String(c[1]).replace(/[₹,\s]/g, "")) }));

export default function Zakat() {
  const { user } = useAuth();
  const admin = user?.superadmin || user?.role === "admin";
  const [to, setTo] = useState(today());
  const [rate, setRate] = useState(2.5);
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [onlyStock, setOnlyStock] = useState(true);
  const load = () => {
    setData(null);
    api
      .get("/zakat", { params: { to, rate } })
      .then((r) => setData(r.data))
      .catch((e) => (toast(errMsg(e), "error"), setData({ rows: [], totals: {} })));
  };
  useEffect(() => {
    if (admin) load();
  }, [to, rate]);
  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.rows.filter((r) => (!onlyStock || r.qty > 0) && (!s || r.name.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s)));
  }, [data, q, onlyStock]);
  const saved = (id, n) =>
    setData((d) => {
      const rows2 = d.rows.map((r) => (r._id === id ? { ...r, zakatCost: n, zakatValue: Math.round(Math.max(0, r.qty) * n * 100) / 100 } : r));
      const total = Math.round(rows2.reduce((s, r) => s + r.zakatValue, 0) * 100) / 100;
      return { ...d, rows: rows2, totals: { ...d.totals, zakatValue: total, zakat: Math.round(total * d.rate) / 100, missing: rows2.filter((r) => r.qty > 0 && !r.zakatCost).length } };
    });
  const upload = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      const list = parseCsv(String(r.result || ""));
      if (!list.length) return toast("No rows found — use a CSV with SKU and zakat cost columns", "error");
      try {
        const { data: res } = await api.post("/zakat/bulk", { rows: list });
        toast(`Zakat cost set on ${res.updated} item(s)${res.unknownCount ? ` · ${res.unknownCount} SKU(s) not found` : ""}`, res.unknownCount ? "error" : "success");
        load();
      } catch (er) {
        toast(errMsg(er), "error");
      }
    };
    r.readAsText(f);
  };
  const download = () => {
    const lines = [["SKU", "Item", "Qty", "Zakat cost", "Zakat value"], ...(data?.rows || []).map((r) => [r.sku, r.name, r.qty, r.zakatCost, r.zakatValue])];
    const csv = lines.map((l) => l.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `zakat-${to}.csv`;
    a.click();
  };
  if (!admin) return <div className="card">Only admins can open this page.</div>;
  return (
    <>
      <PageHeader title="Zakat valuation" />
      <div className="card" style={{ marginBottom: 14 }}>
        <p className="muted small" style={{ marginTop: 0 }}>
          Private to admins. The <strong>zakat cost</strong> of each item is kept apart from its accounting cost: it posts
          nothing and appears in no report, item screen or dashboard. Zakat is worked out on the stock held on the date below.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label>
            <span className="small">Stock as on</span>
            <input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className="small">Zakat rate %</span>
            <input type="number" step="0.01" min="0" style={{ width: 90 }} value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
          <label className="btn">
            Upload zakat costs (CSV: SKU, cost)
            <input type="file" accept=".csv,.txt,text/csv" hidden onChange={upload} />
          </label>
          <button className="btn" onClick={download} disabled={!data}>
            Download CSV
          </button>
        </div>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <div className="card" style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <div className="muted small">Stock at zakat cost</div>
              <strong style={{ fontSize: 20 }}>{money(data.totals.zakatValue)}</strong>
            </div>
            <div>
              <div className="muted small">Zakat @ {data.rate}%</div>
              <strong style={{ fontSize: 20 }}>{money(data.totals.zakat)}</strong>
            </div>
            <div>
              <div className="muted small">Same stock in the books (accounting cost)</div>
              <strong style={{ fontSize: 20 }}>{money(data.totals.bookValue)}</strong>
            </div>
            {data.totals.missing > 0 && (
              <div className="small" style={{ color: "#b45309", alignSelf: "center" }}>
                {data.totals.missing} item(s) in stock have no zakat cost yet (counted as 0)
              </div>
            )}
          </div>
          <div className="card">
            <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
              <label className="small">
                <input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Only items in stock
              </label>
              <span className="muted small">{rows.length} item(s)</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU</th>
                  <th className="num">Qty</th>
                  <th className="num">Book value</th>
                  <th className="num">Zakat cost</th>
                  <th className="num">Zakat value</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((r) => (
                  <tr key={r._id}>
                    <td>{r.name}</td>
                    <td className="muted">{r.sku}</td>
                    <td className="num">
                      {r.qty} {r.unit}
                    </td>
                    <td className="num muted">{money(r.bookValue)}</td>
                    <td className="num">
                      <CostCell row={r} onSaved={saved} />
                    </td>
                    <td className="num">{money(r.zakatValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 && <p className="muted small">Showing the first 500 — search to find others.</p>}
          </div>
        </>
      )}
    </>
  );
}
