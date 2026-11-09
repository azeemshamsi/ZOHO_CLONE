import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader } from "../components/ui";

// Short beep: high for success, low for a problem.
export function beep(ok) {
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

// Barcode types found on courier labels and Shopify packing slips.
const NATIVE_FORMATS = ["code_128", "code_39", "code_93", "codabar", "itf", "ean_13", "ean_8", "upc_a", "qr_code", "data_matrix", "pdf417"];

// Camera scanner. Uses the phone's built-in barcode detector when there is one (Chrome on Android:
// fast and good with long courier barcodes), otherwise ZXing (iPhone / other browsers).
export function Camera({ onCodes, onClose, last, busy }) {
  const video = useRef();
  const [err, setErr] = useState("");
  const [engine, setEngine] = useState("");
  const [torch, setTorch] = useState(null); // null = not supported
  const [seen, setSeen] = useState("");
  const trackRef = useRef(null);
  useEffect(() => {
    let stopped = false;
    let stream;
    let zx;
    let timer;
    let last = "";
    let lastAt = 0;
    const emit = (codes) => {
      const list = [...new Set(codes.map((c) => String(c || "").trim()).filter((c) => c.length >= 4))];
      if (!list.length) return;
      // Longest first: the AWB is usually the longest barcode on a label.
      list.sort((a, b) => b.length - a.length);
      const key = list.join("|");
      if (key === last && Date.now() - lastAt < 3000) return; // same label still in view
      last = key;
      lastAt = Date.now();
      setSeen(list[0]);
      onCodes(list);
    };
    (async () => {
      try {
        if (!window.isSecureContext) throw new Error("The camera only works on https:// — open https://ordexago.com");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const caps = track.getCapabilities?.() || {};
        const adv = [];
        if (caps.focusMode?.includes("continuous")) adv.push({ focusMode: "continuous" });
        if (adv.length) await track.applyConstraints({ advanced: adv }).catch(() => {});
        if (caps.torch) setTorch(false);
        video.current.srcObject = stream;
        await video.current.play().catch(() => {});

        let native = null;
        if ("BarcodeDetector" in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
          const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
          if (formats.length) native = new window.BarcodeDetector({ formats });
        }
        if (native) {
          setEngine("built-in");
          const tick = async () => {
            if (stopped) return;
            try {
              if (video.current?.readyState >= 2) {
                const found = await native.detect(video.current);
                if (found.length) emit(found.map((b) => b.rawValue));
              }
            } catch {}
            timer = setTimeout(tick, 120);
          };
          tick();
        } else {
          setEngine("zxing");
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const { DecodeHintType, BarcodeFormat } = await import("@zxing/library");
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]);
          hints.set(DecodeHintType.TRY_HARDER, true);
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 400 });
          zx = await reader.decodeFromStream(stream, video.current, (result) => {
            if (result && !stopped) emit([result.getText()]);
          });
        }
      } catch (e) {
        const m = e?.name || e?.message || String(e);
        setErr(/Permission|NotAllowed/i.test(m) ? "Camera permission was refused. Allow camera access for this site in your browser settings, then try again." : /NotFound|Overconstrained/i.test(m) ? "No camera found on this device." : e?.message || `Couldn't start the camera: ${m}`);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      zx?.stop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const toggleTorch = async () => {
    const on = !torch;
    await trackRef.current?.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
    setTorch(on);
  };
  return (
    <div className="scan-camera">
      {err ? <div className="alert alert-error">{err}</div> : <video ref={video} playsInline muted autoPlay />}
      {!err && <div className="scan-frame" />}
      {(busy || last) && (
        <div className={`scan-banner ${busy ? "busy" : last.kind}`}>
          {busy ? (
            <strong>Checking…</strong>
          ) : (
            <>
              <strong>
                {last.kind === "ok" ? "✓ " : last.kind === "warn" ? "! " : "✕ "}
                {last.message}
              </strong>
              {last.order && (
                <span>
                  {last.order.customer} · {last.order.awb} · {money(last.order.total)}
                </span>
              )}
              {last.pending && !last.sync && <span>Updating Shopify and the books…</span>}
              {last.sync?.state === "done" && last.sync.creditNoteNumber && <span>Credit note {last.sync.creditNoteNumber} made</span>}
              {last.sync?.state === "error" && <span>{last.sync.message} — scan again to retry</span>}
              {last.warning && <span>{last.warning}</span>}
            </>
          )}
        </div>
      )}
      <div className="scan-cam-bar">
        <span className="muted small">{seen ? `Read: ${seen}` : engine ? "Hold the barcode flat, 10–20 cm away, filling the box" : "Starting camera…"}</span>
        {torch !== null && (
          <button className="btn btn-sm" onClick={toggleTorch}>
            {torch ? "Light off" : "Light on"}
          </button>
        )}
        <button className="btn btn-sm" onClick={onClose}>
          Close camera
        </button>
      </div>
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
  useEffect(() => {
    focus();
  }, []);

  const busyRef = useRef(false);
  // Shopify return + credit note finish in the background: check back a few times.
  const follow = (id, at) => {
    let n = 0;
    const check = async () => {
      n += 1;
      try {
        const { data } = await api.get(`/shopify/returns/${id}/sync`);
        if (data.state === "pending" && n < 8) return setTimeout(check, 2500);
        setLog((l) => l.map((x) => (x.at === at ? { ...x, sync: data } : x)));
      } catch {}
    };
    setTimeout(check, 2000);
  };
  const submit = async (value) => {
    const codes = (Array.isArray(value) ? value : [String(value ?? code)]).map((x) => x.trim()).filter(Boolean);
    if (!codes.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setCode("");
    const at = new Date();
    const shown = codes[0];
    try {
      const { data } = await api.post("/shopify/returns/scan", { codes });
      const kind = data.already ? "warn" : "ok";
      beep(!data.already);
      setLog((l) => [{ code: data.order?.awb && codes.includes(data.order.awb) ? data.order.awb : shown, kind, ...data, at }, ...l].slice(0, 50));
      if (data.pending && data.order?._id) follow(data.order._id, at);
    } catch (e) {
      beep(false);
      setLog((l) => [{ code: shown, kind: "bad", message: errMsg(e), at }, ...l].slice(0, 50));
    }
    busyRef.current = false;
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
      {camera && <Camera onCodes={(list) => submit(list)} onClose={() => setCamera(false)} last={log[0]} busy={busy} />}
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
                {x.pending && !x.sync && <div className="muted small">Updating Shopify and the books…</div>}
                {x.sync?.state === "done" && <div className="small text-paid">{x.sync.creditNoteNumber ? `Credit note ${x.sync.creditNoteNumber} made` : "Shopify updated"}{x.sync.message ? ` · ${x.sync.message}` : ""}</div>}
                {x.sync?.state === "error" && <div className="small text-amber">{x.sync.message} — scan again to retry</div>}
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
