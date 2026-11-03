import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { toast } from "./ui";

// When a search finds nothing in OrdexaGo: look for it in Shopify and offer to add it as an item.
export default function ShopifyLookup({ q, onCreated }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!q || q.trim().length < 2) return setRows(null);
    let live = true;
    setRows(undefined);
    setErr("");
    api
      .get("/stock/shopify/variants", { params: { q: q.trim() } })
      .then((r) => live && setRows(r.data))
      .catch((e) => live && (setErr(errMsg(e)), setRows(null)));
    return () => {
      live = false;
    };
  }, [q]);
  const create = async (v) => {
    setBusy(v.variantId);
    try {
      const { data } = await api.post("/stock/shopify/create-item", { variantId: v.variantId });
      toast(data.created ? `Added ${data.name}` : `Matched to existing item ${data.name} (SKU added)`);
      setRows((rs) => rs.map((x) => (x.variantId === v.variantId ? { ...x, item: { _id: data._id, name: data.name } } : x)));
      onCreated?.(data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  if (!q || q.trim().length < 2) return null;
  if (rows === undefined) return <p className="muted small">Looking in Shopify…</p>;
  if (err) return <p className="muted small">Not in Shopify either ({err}).</p>;
  if (!rows?.length) return <p className="muted small">Not found in Shopify either.</p>;
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="label-sm">Found in Shopify</div>
      <table className="table compact">
        <tbody>
          {rows.map((v) => (
            <tr key={v.variantId}>
              <td style={{ width: 48 }}>{v.image && <img src={v.image} alt="" className="ship-thumb" />}</td>
              <td>
                {v.title}
                <div className="muted small">SKU {v.sku || "—"}</div>
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {v.item ? (
                  <Link to={`/items/${v.item._id}`} className="small">
                    In OrdexaGo: {v.item.name}
                  </Link>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => create(v)}>
                    {busy === v.variantId ? "Adding…" : "Add to OrdexaGo"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Adding uses the same matching as orders: an existing item with this SKU or name gets the Shopify link and SKU; otherwise a new item is made with its HSN/GST from your category rules.</p>
    </div>
  );
}
