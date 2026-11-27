import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader } from "../components/ui";
import { Camera, beep } from "./ReturnScan";

// Scan each parcel's AWB just before handing it to the courier. Only a record (date and time stay on the order);
// the order moves to the "AWB Scanned" tab until the courier's own pickup scan marks it Shipped.
export function AwbScan() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [log, setLog] = useState([]);
  // AWBs that aren't orders in OrdexaGo (Amazon / Flipkart / Pepperfry shipped outside it) are recorded under this.
  const [channel, setChannel] = useState(() => {
    try {
      return localStorage.getItem("awbScanChannel") || "";
    } catch {
      return "";
    }
  });
  const pickChannel = (v) => {
    setChannel(v);
    try {
      localStorage.setItem("awbScanChannel", v);
    } catch {}
  };
  const input = useRef();
  const busyRef = useRef(false);
  const focus = () => setTimeout(() => input.current?.focus(), 50);
  useEffect(() => {
    focus();
  }, []);

  const submit = async (value) => {
    const codes = (Array.isArray(value) ? value : [String(value ?? code)]).map((x) => x.trim()).filter(Boolean);
    if (!codes.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setCode("");
    const at = new Date();
    try {
      const { data } = await api.post("/shopify/orders/awb-scan", { codes, channel });
      beep(!data.already);
      setLog((l) => [{ code: codes[0], kind: data.already ? "warn" : "ok", ...data, at }, ...l].slice(0, 200));
    } catch (e) {
      beep(false);
      setLog((l) => [{ code: codes[0], kind: "bad", message: errMsg(e), at }, ...l].slice(0, 200));
    }
    busyRef.current = false;
    setBusy(false);
    if (!camera) focus();
  };

  const ok = log.filter((x) => x.kind === "ok").length;
  const byCourier = log
    .filter((x) => x.kind === "ok")
    .reduce((m, x) => ({ ...m, [x.order?.courier || "Other"]: (m[x.order?.courier || "Other"] || 0) + 1 }), {});
  return (
    <div className="scan-page">
      <PageHeader title="Scan AWB" subtitle="Scan each parcel's AWB before handing it to the courier. Only a record: the time stays on the order." />
      <form
        className="scan-box card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input ref={input} className="scan-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type AWB / order no." autoComplete="off" autoCapitalize="characters" enterKeyHint="go" inputMode="text" />
        <div className="scan-actions">
          <button className="btn btn-primary" disabled={busy || !code.trim()}>
            {busy ? "Checking…" : "Record handover"}
          </button>
          <button type="button" className="btn" onClick={() => setCamera(!camera)}>
            {camera ? "Stop camera" : "📷 Scan with camera"}
          </button>
        </div>
        <label className="small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          AWBs not in OrdexaGo belong to
          <MarketplaceSelect value={channel} onChange={pickChannel} empty="— ask me (show an error) —" />
        </label>
        <p className="muted small">A barcode scanner works here too — it types the number and presses Enter.</p>
      </form>
      {camera && <Camera onCodes={(list) => submit(list)} onClose={() => setCamera(false)} last={log[0]} busy={busy} />}
      {log.length > 0 && (
        <div className="scan-log">
          <div className="label-sm">
            This session: {ok} scanned
            {Object.keys(byCourier).length ? ` (${Object.entries(byCourier).map(([c, n]) => `${c} ${n}`).join(", ")})` : ""}
            {log.length - ok ? ` · ${log.length - ok} not recorded` : ""}
          </div>
          {log.map((x, i) => (
            <div key={i} className={`scan-result ${x.kind}`}>
              <div>
                <strong>{x.message}</strong>
                {x.order && (
                  <div className="small">
                    {[x.order.customer, x.order.courier ? `${x.order.courier} ${x.order.awb}` : x.order.awb].filter(Boolean).join(" · ")}
                    {x.order.items?.length > 0 && <div className="muted">{x.order.items.join(", ")}</div>}
                  </div>
                )}
                <div className="muted small">
                  Scanned "{x.code}" at {x.at.toLocaleTimeString("en-IN")}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <ScanHistory version={log.length} />
      <p className="muted small" style={{ marginTop: 16 }}>
        Scanned parcels show in <Link to="/shopify-orders?tab=awb_scanned">AWB Scanned</Link> until the courier's pickup scan moves them to Shipped. Orders still in <Link to="/shopify-orders?tab=ready_to_ship">Ready to Ship</Link> were booked but never handed over.
      </p>
    </div>
  );
}

// Marketplace for AWBs that aren't orders in OrdexaGo: Amazon / Flipkart / Pepperfry / Other, names typed in before
// (from earlier scans and this device), or "+ Add marketplace…" to type a new one (Meesho, JioMart…).
export function MarketplaceSelect({ value, onChange, empty = "— ask me —" }) {
  const [names, setNames] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("awbScanMarketplaces") || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    api
      .get("/shopify/orders/awb-scan-channels")
      .then((r) => setNames((cur) => [...new Set([...cur, ...r.data])]))
      .catch(() => {});
  }, []);
  const BUILT = ["amazon", "flipkart", "pepperfry", "other"];
  const custom = [...new Set([...names, ...(value && !BUILT.includes(value) ? [value] : [])])].filter((n) => n && !BUILT.includes(n.toLowerCase()));
  const pick = (v) => {
    if (v !== "__add") return onChange(v);
    const name = (window.prompt("Marketplace name (e.g. Meesho, JioMart, Myntra)") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) return;
    const known = BUILT.find((b) => b === name.toLowerCase());
    if (known) return onChange(known);
    const next = [...new Set([name, ...names])];
    setNames(next);
    try {
      localStorage.setItem("awbScanMarketplaces", JSON.stringify(next.slice(0, 50)));
    } catch {}
    onChange(name);
  };
  return (
    <select value={value} onChange={(e) => pick(e.target.value)}>
      <option value="">{empty}</option>
      <option value="amazon">Amazon</option>
      <option value="flipkart">Flipkart</option>
      <option value="pepperfry">Pepperfry</option>
      {custom.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
      <option value="other">Other</option>
      <option value="__add">+ Add marketplace…</option>
    </select>
  );
}

// Every handover scan, for checking later: search an AWB or order number, or look at a date range.
function ScanHistory({ version }) {
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState(null);
  const load = () =>
    api
      .get("/shopify/orders/awb-scans", { params: q.trim() ? { q: q.trim() } : { from, to } })
      .then((r) => setRows(r.data))
      .catch((e) => setRows({ error: errMsg(e) }));
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q, from, to, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const csv = () => {
    const lines = [["Scanned at", "AWB", "Order", "Marketplace / channel", "Courier", "Scanned by"], ...(rows || []).map((r) => [new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), r.code, r.orderName || "", r.channel || "", r.courier || "", r.byName || ""])];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.map((l) => l.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n")], { type: "text/csv" }));
    a.download = `awb-scans-${from}-${to}.csv`;
    a.click();
  };
  const NAME = { shopify: "Shopify", amazon: "Amazon", flipkart: "Flipkart", pepperfry: "Pepperfry", other: "Other" };
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="label-sm" style={{ marginBottom: 8 }}>
        Scan history
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginBottom: 10 }}>
        <input placeholder="Find an AWB or order no." value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
        {!q.trim() && (
          <>
            <label className="small">
              From <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="small">
              To <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <button type="button" className="btn btn-sm" onClick={csv} disabled={!Array.isArray(rows) || !rows.length}>
          Download CSV
        </button>
      </div>
      {!rows ? (
        <div className="muted small">Loading…</div>
      ) : rows.error ? (
        <div className="small">{rows.error}</div>
      ) : !rows.length ? (
        <div className="muted small">{q.trim() ? `"${q.trim()}" was never scanned.` : "No parcels scanned in these dates."}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            {rows.length} scan(s)
            {(() => {
              const by = rows.reduce((m, r) => ({ ...m, [NAME[r.channel] || r.channel || "—"]: (m[NAME[r.channel] || r.channel || "—"] || 0) + 1 }), {});
              return ` · ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ")}`;
            })()}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Scanned at</th>
                <th>AWB</th>
                <th>Order</th>
                <th>Channel</th>
                <th>Courier</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td>{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{r.code}</td>
                  <td>{r.orderName || <span className="muted">not in OrdexaGo</span>}</td>
                  <td>{NAME[r.channel] || r.channel || "—"}</td>
                  <td>{r.courier || ""}</td>
                  <td>{r.byName || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
