import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Field, Modal, SearchBox, useDebounced, toast } from "../components/ui";

const DIMS = [
  ["weight", "Weight (kg)"],
  ["length", "Length (cm)"],
  ["breadth", "Breadth (cm)"],
  ["height", "Height (cm)"],
];

// Products using a package type: search items by SKU or name and add them.
function ProductPicker({ products, onChange }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [hits, setHits] = useState([]);
  useEffect(() => {
    if (!dq || dq.length < 2) return setHits([]);
    api.get("/items", { params: { q: dq, status: "active" } }).then((r) => setHits(r.data.filter((i) => i.type !== "service").slice(0, 15))).catch(() => {});
  }, [dq]);
  const has = (id) => products.some((p) => p._id === id);
  return (
    <div>
      <div className="label-sm">Products that ship in this package ({products.length})</div>
      {products.length > 0 && (
        <table className="table compact">
          <tbody>
            {products.map((p) => (
              <tr key={p._id}>
                <td>
                  <strong>{p.sku || "—"}</strong> <span className="muted">{p.name}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <button type="button" className="link-btn small" onClick={() => onChange(products.filter((x) => x._id !== p._id))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SearchBox value={q} onChange={setQ} placeholder="Add products: search SKU or name…" />
      {hits.length > 0 && (
        <table className="table compact" style={{ marginTop: 6 }}>
          <tbody>
            {hits.map((i) => (
              <tr key={i._id}>
                <td>
                  <strong>{i.sku || "—"}</strong> <span className="muted">{i.name}</span>
                  {i.packageType && <span className="muted small"> · has a package type</span>}
                </td>
                <td style={{ textAlign: "right" }}>
                  {has(i._id) ? (
                    <span className="muted small">Added</span>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => onChange([...products, { _id: i._id, sku: i.sku, name: i.name }])}>
                      Add
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackageModal({ pt, onClose, onSaved }) {
  const [f, setF] = useState({ name: pt.name || "", weight: pt.weight ?? "", length: pt.length ?? "", breadth: pt.breadth ?? "", height: pt.height ?? "" });
  const [products, setProducts] = useState(pt.products || []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, ...Object.fromEntries(DIMS.map(([k]) => [k, Number(f[k])])) };
      const before = new Set((pt.products || []).map((p) => p._id));
      const now = new Set(products.map((p) => p._id));
      let id = pt._id;
      if (id) await api.put(`/shopify/package-types/${id}`, body);
      else id = (await api.post("/shopify/package-types", body)).data._id;
      const add = [...now].filter((x) => !before.has(x));
      const remove = [...before].filter((x) => !now.has(x));
      if (add.length) await api.post("/shopify/package-types/assign", { items: add, packageType: id });
      if (remove.length) await api.post("/shopify/package-types/assign", { items: remove, packageType: null });
      toast("Package type saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${pt.name}? Its products will have no package type.`)) return;
    try {
      await api.delete(`/shopify/package-types/${pt._id}`);
      toast("Package type deleted");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <Modal
      open
      wide
      title={pt._id ? `Edit ${pt.name}` : "New package type"}
      onClose={onClose}
      footer={
        <>
          {pt._id && (
            <button className="btn btn-danger" style={{ marginRight: "auto" }} onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" required hint="e.g. the SKU, or Box M, Flyer L">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <div className="row-4">
          {DIMS.map(([k, l]) => (
            <Field key={k} label={l} required>
              <input type="number" step="0.01" min="0" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <ProductPicker products={products} onChange={setProducts} />
      </div>
    </Modal>
  );
}

export function PackageTypes() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/shopify/package-types", { params: { q: dq || undefined } }).then((r) => setRows(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [dq]);
  return (
    <>
      <PageHeader title="Package Types" subtitle="The box each product ships in: packed weight and size. Bookings and courier rates use the product's package type automatically.">
        <SearchBox value={q} onChange={setQ} placeholder="Search name, SKU, product, size…" />
        <button className="btn btn-primary" onClick={() => setEdit({})}>
          + New
        </button>
      </PageHeader>
      <div className="card flush">
        {!rows ? (
          <Spinner />
        ) : !rows.length ? (
          <div className="empty-row muted">{q ? `No package types match “${q}”.` : "No package types yet. Create one here, or from the booking screen after typing a weight and size."}</div>
        ) : (
          <table className="table table-click">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Weight</th>
                <th>Size (L × B × H)</th>
                <th>Products</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p._id} onClick={() => setEdit(p)}>
                  <td data-label="Name">
                    <strong>{p.name}</strong>
                  </td>
                  <td data-label="Weight" className="num">
                    {p.weight} kg
                  </td>
                  <td data-label="Size">
                    {p.length} × {p.breadth} × {p.height} cm
                  </td>
                  <td data-label="Products" className="small">
                    {p.items ? (
                      <>
                        {p.products
                          .slice(0, 4)
                          .map((x) => x.sku || x.name)
                          .join(", ")}
                        {p.items > 4 && <span className="muted"> +{p.items - 4} more</span>}
                      </>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <PackageModal
          pt={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
    </>
  );
}
