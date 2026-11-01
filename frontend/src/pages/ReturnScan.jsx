import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader } from "../components/ui";

// Short beep: high for success, low for a problem.
function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
  } catch {}
}

function Camera({ onCode, onClose }) {
  const video = useRef();
  const [err, setErr] = useState("");
  useEffect(() => {
    let controls;
    let stopped = false;
    let last = "";
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } } }, video.current, (result) => {
          if (!result || stopped) return;
          const text = result.getText();
          if (text && text !== last) {
            last = text;
            onCode(text);
            setTimeout(() => (last = ""), 2500); // the same label isn't read twice in a row
          }
        });
      } catch (e) {
        setErr(/Permission|NotAllowed/i.test(e?.name || e?.message) ? "Camera permission was refused. Allow camera access for this site in your browser settings." : `Couldn't start the camera: ${e?.message || e}`);
      }
    })();
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, []);
  return (
    <div className="scan-camera">
      {err ? <div className="alert alert-error">{err}</div> : <video ref={video} playsInline muted />}
      <div className="scan-frame" />
      <button className="btn" onClick={onClose}>
        Close camera
      </button>
    </div>
  );
}

export function ReturnScan() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [log, setLog] = useState([]);
  const input = useRef();
  const focus = () => setTimeout(() => input.current?.focus(), 50);
  useEffect(focus, []);

  const submit = async (value) => {
    const c = String(value ?? code).trim();
    if (!c || busy) return;
    setBusy(true);
    setCode("");
    try {
      const { data } = await api.post("/shopify/returns/scan", { code: c });
      const kind = data.already ? "warn" : "ok";
      beep(!data.already);
      setLog((l) => [{ code: c, kind, ...data, at: new Date() }, ...l].slice(0, 50));
    } catch (e) {
      beep(false);
      setLog((l) => [{ code: c, kind: "bad", message: errMsg(e), at: new Date() }, ...l].slice(0, 50));
    }
    setBusy(false);
    if (!camera) focus();
  };

  const closed = log.filter((x) => x.kind === "ok").length;
  return (
    <div className="scan-page">
      <PageHeader title="Close Returns" subtitle="Scan the AWB or order number on each returned parcel (RTO or customer return)." />
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
            {busy ? "Checking…" : "Close Return"}
          </button>
          <button type="button" className="btn" onClick={() => setCamera(!camera)}>
            {camera ? "Stop camera" : "📷 Scan with camera"}
          </button>
        </div>
        <p className="muted small">A barcode scanner works here too — it types the number and presses Enter.</p>
      </form>
      {camera && <Camera onCode={(t) => submit(t)} onClose={() => setCamera(false)} />}
      {log.length > 0 && (
        <div className="scan-log">
          <div className="label-sm">
            This session: {closed} closed{log.length - closed ? `, ${log.length - closed} not closed` : ""}
          </div>
          {log.map((x, i) => (
            <div key={i} className={`scan-result ${x.kind}`}>
              {x.order?.image ? <img src={x.order.image} alt="" className="ship-thumb" /> : null}
              <div>
                <strong>{x.message}</strong>
                {x.order && (
                  <div className="small">
                    {x.order.customer} · {x.order.courier ? `${x.order.courier} ${x.order.awb}` : x.order.awb} · {money(x.order.total)}
                    <div className="muted">{x.order.items.join(", ")}</div>
                  </div>
                )}
                {x.warning && <div className="small text-amber">{x.warning}</div>}
                <div className="muted small">
                  Scanned "{x.code}" at {x.at.toLocaleTimeString("en-IN")}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 16 }}>
        Closing a return marks the order Returned, closes it in Shopify, and for invoiced orders makes a credit note so the stock comes back. <Link to="/shopify-orders?tab=returned">Returned orders</Link>
      </p>
    </div>
  );
}
