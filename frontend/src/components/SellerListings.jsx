import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { Spinner, Empty, toast } from "./ui";
import { readB64 } from "./PaymentProofs";

// Seller dashboard → Listings: download the sample listing file, upload it back, see problems by row, submit.
// Products become drafts on the marketplace's Shopify store; the marketplace checks, prices and approves them.

const STATUS = {
  queued: ["Submitted", ""],
  creating: ["Submitted", ""],
  draft: ["Under review", "pill-amber"],
  failed: ["Couldn't create — we'll check", "pill-red"],
  approved: ["Live", "pill-green"],
  rejected: ["Rejected", ""],
};

export default function SellerListings({ brands = [] }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("all");
  const [file, setFile] = useState(null); // { name, b64 }
  const [brand, setBrand] = useState(brands[0] || "");
  const [checked, setChecked] = useState(null);
  const [busy, setBusy] = useState("");
  const ref = useRef();
  const load = () =>
    api
      .get("/seller-portal/listings", { params: { status } })
      .then((r) => setData(r.data))
      .catch(
        (e) => (toast(errMsg(e), "error"), setData({ rows: [], counts: {} })),
      );
  useEffect(() => {
    load();
  }, [status]);
  useEffect(() => {
    if (!data?.rows.some((l) => ["queued", "creating"].includes(l.status)))
      return;
    const t = setTimeout(load, 6000);
    return () => clearTimeout(t);
  }, [data]);

  const sample = async () => {
    try {
      const r = await api.get("/seller-portal/listings/sample", {
        responseType: "blob",
      });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "woodentwist-listing-file.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const pick = async (f) => {
    if (!f) return;
    if (!/\.(xlsx|xls|csv)$/i.test(f.name))
      return toast("Upload the .xlsx or .csv listing file", "error");
    if (f.size > 10 * 1024 * 1024)
      return toast("The file is over 10 MB", "error");
    const b64 = await readB64(f);
    setFile({ name: f.name, b64 });
    setChecked(null);
    setBusy("check");
    try {
      const { data: r } = await api.post("/seller-portal/listings/check", {
        file: b64,
        name: f.name,
        brand,
      });
      setChecked(r);
    } catch (e) {
      toast(errMsg(e), "error");
      setFile(null);
    }
    setBusy("");
  };
  const submit = async () => {
    setBusy("submit");
    try {
      const { data: r } = await api.post("/seller-portal/listings", {
        file: file.b64,
        name: file.name,
        brand,
      });
      toast(
        `${r.submitted} product${r.submitted === 1 ? "" : "s"} submitted for review${r.skipped ? ` · ${r.skipped} with problems left out — fix and upload them again` : ""}`,
      );
      setFile(null);
      setChecked(null);
      setStatus("all");
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  const good = checked?.products.filter((p) => p.ok).length || 0;
  const c = data?.counts || {};
  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h4 className="section-title" style={{ marginTop: 0 }}>
          Add products
        </h4>
        <ol
          className="small"
          style={{ margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.7 }}
        >
          <li>
            Download the listing file and read its <b>Guidelines</b> sheet.{" "}
            <button type="button" className="btn btn-sm" onClick={sample}>
              Download listing file
            </button>
          </li>
          <li>
            Fill one row per product (extra rows for variants and extra images),
            with direct image links.
          </li>
          <li>
            Upload it here. We show any problem by row; fix them and upload
            again, or submit the products that are ready.
          </li>
          <li>
            We check each product, set the selling price and make it live.
            You'll see the status below.
          </li>
        </ol>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {brands.length > 1 && (
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              title="Brand for rows with no Vendor"
            >
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => ref.current?.click()}
          >
            {busy === "check" ? "Checking the file…" : "Upload listing file"}
          </button>
          <input
            ref={ref}
            type="file"
            hidden
            accept=".xlsx,.xls,.csv"
            onChange={(e) => (pick(e.target.files[0]), (e.target.value = ""))}
          />
          {file && <span className="small muted">{file.name}</span>}
        </div>
        {checked && (
          <div style={{ marginTop: 12 }}>
            <div
              className={`alert ${checked.problems.length ? "alert-warn" : "alert-info"} small`}
            >
              {checked.products.length} product
              {checked.products.length === 1 ? "" : "s"} in {checked.rows} rows
              · <b>{good} ready</b>
              {checked.problems.length > 0 &&
                ` · ${checked.products.length - good} with problems (below)`}
            </div>
            {checked.problems.length > 0 && (
              <div style={{ maxHeight: 260, overflow: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Product</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checked.problems.map((p, i) => (
                      <tr key={i}>
                        <td className="small">{p.row}</td>
                        <td className="small">{p.handle || "—"}</td>
                        <td className="small" style={{ color: "var(--red)" }}>
                          {p.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="form-actions">
              <button
                className="btn btn-primary"
                disabled={!good || !!busy}
                onClick={submit}
              >
                {busy === "submit"
                  ? "Submitting…"
                  : `Submit ${good} ready product${good === 1 ? "" : "s"} for review`}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => (setFile(null), setChecked(null))}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="seg" role="group" style={{ marginBottom: 8 }}>
        {[
          ["all", "All", c.all],
          [
            "review",
            "Under review",
            (c.queued || 0) + (c.creating || 0) + (c.draft || 0),
          ],
          ["approved", "Live", c.approved],
          ["rejected", "Rejected", c.rejected],
        ].map(([k, l, n]) => (
          <button
            key={k}
            type="button"
            className={status === k ? "on" : ""}
            onClick={() => setStatus(k)}
          >
            {l} ({n || 0})
          </button>
        ))}
      </div>
      {!data ? (
        <Spinner />
      ) : !data.rows.length ? (
        <Empty
          title="No products uploaded yet"
          text="Download the listing file, fill in your products and upload it above."
        />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th className="num">Your price to us</th>
                <th className="num">Selling price</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((l) => {
                const [label, pill] = STATUS[l.status] || [l.status, ""];
                return (
                  <tr key={l._id}>
                    <td data-label="Product">
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        {l.image && (
                          <img
                            src={l.image}
                            alt=""
                            style={{
                              width: 40,
                              height: 40,
                              objectFit: "cover",
                              borderRadius: 4,
                            }}
                            loading="lazy"
                          />
                        )}
                        <div>
                          {l.title}
                          <div className="small muted">
                            {l.brand}
                            {l.variants.length > 1
                              ? ` · ${l.variants.length} variants`
                              : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td data-label="SKU" className="small">
                      {l.variants.map((v) => v.sku).join(", ")}
                    </td>
                    <td data-label="Your price" className="num">
                      {money(l.variants[0]?.cost)}
                    </td>
                    <td data-label="Selling price" className="num">
                      {l.status === "approved" ? (
                        money(l.variants[0]?.finalPrice ?? l.variants[0]?.price)
                      ) : (
                        <span className="muted">
                          {money(l.variants[0]?.price)} suggested
                        </span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`pill ${pill}`}>{label}</span>
                      {l.status === "rejected" && l.reason && (
                        <div className="small text-amber">{l.reason}</div>
                      )}
                    </td>
                    <td data-label="Uploaded" className="small">
                      {date(l.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
