import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { toast } from "./ui";

export const readB64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });

// Upload one payment screenshot to an order (kept in OrdexaGo and sent to the Shopify order).
export async function uploadProof(orderId, file, reference = "") {
  if (file.size > 10 * 1024 * 1024)
    throw new Error(`${file.name} is over 10 MB`);
  const { data } = await api.post(`/shopify/orders/${orderId}/payment-proofs`, {
    name: file.name || "payment.png",
    type: file.type,
    data: await readB64(file),
    reference,
  });
  return data;
}

// Payment screenshots on a store order: add (or paste / take a photo), view, retry sending to Shopify.
export default function PaymentProofs({ orderId, canEdit = true }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState("");
  const input = useRef();
  const load = () =>
    api
      .get(`/shopify/orders/${orderId}/payment-proofs`)
      .then((r) => setRows(r.data))
      .catch(() => setRows([]));
  useEffect(() => {
    load();
  }, [orderId]);
  const add = async (files) => {
    if (!files.length) return;
    setBusy(true);
    for (const f of files) {
      try {
        const p = await uploadProof(orderId, f, reference.trim());
        toast(
          p.error ? p.error : `${f.name} added to the Shopify order`,
          p.error ? "error" : undefined,
        );
      } catch (e) {
        toast(errMsg(e), "error");
      }
    }
    setReference("");
    if (input.current) input.current.value = "";
    setBusy(false);
    load();
  };
  const open = async (p) => {
    const w = window.open("", "_blank");
    try {
      const r = await api.get(
        `/shopify/orders/${orderId}/payment-proofs/${p._id}/file`,
        { responseType: "blob" },
      );
      const url = URL.createObjectURL(r.data);
      if (w) w.location = url;
      else window.open(url, "_blank");
    } catch (e) {
      if (w) w.close();
      toast(errMsg(e), "error");
    }
  };
  const retry = async (p) => {
    try {
      const { data } = await api.post(
        `/shopify/orders/${orderId}/payment-proofs/${p._id}/retry`,
      );
      toast(data.error || "Sent to Shopify", data.error ? "error" : undefined);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    load();
  };
  if (!rows) return null;
  return (
    <div
      style={{ marginTop: 10 }}
      onPaste={(e) => canEdit && add([...(e.clipboardData?.files || [])])}
    >
      <div className="label-sm">
        Payment proof {rows.length ? `(${rows.length})` : ""}
      </div>
      {rows.map((p) => (
        <div
          key={p._id}
          className="small"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 4,
          }}
        >
          <button type="button" className="link-btn" onClick={() => open(p)}>
            {p.name}
          </button>
          {p.reference && <span className="muted">ref {p.reference}</span>}
          <span className="muted">
            {p.by ? `${p.by}, ` : ""}
            {new Date(p.at).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {p.inShopify ? (
            <span className="pill pill-green">In Shopify</span>
          ) : (
            <>
              <span className="text-red" title={p.error}>
                Not in Shopify
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => retry(p)}
                >
                  Retry
                </button>
              )}
            </>
          )}
        </div>
      ))}
      {canEdit && (
        <div
          style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}
        >
          <input
            placeholder="UTR / reference (optional)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            style={{ maxWidth: 220 }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Uploading…" : "+ Add screenshot"}
          </button>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => add([...e.target.files])}
          />
        </div>
      )}
    </div>
  );
}
