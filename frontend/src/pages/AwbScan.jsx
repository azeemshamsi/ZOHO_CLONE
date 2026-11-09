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
  const input = useRef();
  const busyRef = useRef(false);
  const focus = () => setTimeout(() => input.current?.focus(), 50);
  useEffect(focus, []);

  const submit = async (value) => {
    const codes = (Array.isArray(value) ? value : [String(value ?? code)]).map((x) => x.trim()).filter(Boolean);
    if (!codes.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setCode("");
    const at = new Date();
    try {
      const { data } = await api.post("/shopify/orders/awb-scan", { codes });
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
                    <div className="muted">{x.order.items.join(", ")}</div>
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
      <p className="muted small" style={{ marginTop: 16 }}>
        Scanned parcels show in <Link to="/shopify-orders?tab=awb_scanned">AWB Scanned</Link> until the courier's pickup scan moves them to Shipped. Orders still in <Link to="/shopify-orders?tab=ready_to_ship">Ready to Ship</Link> were booked but never handed over.
      </p>
    </div>
  );
}
