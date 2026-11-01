import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { STATES, stateName } from "../lib/constants";
import { loadLocations } from "../lib/locations";
import { PageHeader, Spinner, Field, Modal, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

export function Locations() {
  const [branches, setBranches] = useState(null);
  const [warehouses, setWarehouses] = useState(null);
  const [modal, setModal] = useState(null); // {kind, item}
  const [del, setDel] = useState(null);
  const load = () => {
    api.get("/branches").then((r) => setBranches(r.data));
    api.get("/warehouses").then((r) => setWarehouses(r.data));
    loadLocations(true);
  };
  useEffect(load, []);
  if (!branches || !warehouses) return <Spinner />;
  const branchName = (id) => branches.find((b) => b._id === id)?.name || "Head Office";
  return (
    <>
      <PageHeader title="Branches & Warehouses" subtitle="Branches carry their own GSTIN and address on documents; warehouses hold stock." />
      <div className="card flush">
        <div className="pad-row">
          <h3 className="card-title pad">Branches</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setModal({ kind: "branch" })}>
            <Icon name="plus" size={14} /> New Branch
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>GSTIN</th>
              <th>State</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="strong">Head Office</td>
              <td className="muted">From Settings</td>
              <td className="muted">Organization profile</td>
              <td>
                <span className="status status-paid">Default</span>
              </td>
              <td />
            </tr>
            {branches.map((b) => (
              <tr key={b._id}>
                <td className="strong">
                  {b.name}
                  {b.code && <span className="muted small"> · {b.code}</span>}
                </td>
                <td className="mono">{b.gstin || "—"}</td>
                <td>{stateName(b.state)}</td>
                <td>
                  <span className={`status status-${b.active ? "paid" : "void"}`}>{b.active ? "Active" : "Inactive"}</span>
                </td>
                <td className="num nowrap">
                  <button className="icon-btn" onClick={() => setModal({ kind: "branch", item: b })}>
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => setDel({ kind: "branch", item: b })}>
                    <Icon name="trash" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ padding: "0 16px 14px" }}>
          Pick a branch on invoices, bills and expenses: GST (CGST+SGST vs IGST) is worked out from the branch's state, and every report can be filtered by branch. Payments follow the branch of the invoice or bill they settle.
        </p>
      </div>
      <div className="card flush">
        <div className="pad-row">
          <h3 className="card-title pad">Warehouses</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setModal({ kind: "warehouse" })}>
            <Icon name="plus" size={14} /> New Warehouse
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Branch</th>
              <th>City</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w._id}>
                <td className="strong">
                  {w.name} {w.primary && <span className="status status-sent">Primary</span>} {!w.active && <span className="status status-void">Inactive</span>}
                </td>
                <td>{branchName(w.branch)}</td>
                <td>{w.address?.city}</td>
                <td className="num nowrap">
                  <button className="icon-btn" onClick={() => setModal({ kind: "warehouse", item: w })}>
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => setDel({ kind: "warehouse", item: w })}>
                    <Icon name="trash" size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {!warehouses.length && (
              <tr>
                <td colSpan={4} className="muted center">
                  No warehouses — all stock sits in one place. Add two or more to track stock by location.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {modal && <LocationModal {...modal} branches={branches} onClose={() => setModal(null)} onSaved={() => (setModal(null), load())} />}
      <Confirm
        open={!!del}
        title={`Delete ${del?.item.name}?`}
        text="Only possible when it has no transactions."
        onConfirm={async () => {
          try {
            await api.delete(`/${del.kind === "branch" ? "branches" : "warehouses"}/${del.item._id}`);
            toast("Deleted");
            load();
          } catch (e) {
            toast(errMsg(e), "error");
          }
          setDel(null);
        }}
        onCancel={() => setDel(null)}
      />
    </>
  );
}

function LocationModal({ kind, item, branches, onClose, onSaved }) {
  const isB = kind === "branch";
  const [f, setF] = useState(
    isB
      ? { prefixes: { ...(item?.prefixes || {}) }, name: item?.name || "", code: item?.code || "", gstin: item?.gstin || "", state: item?.state || "", street: item?.address?.street || "", city: item?.address?.city || "", pincode: item?.address?.pincode || "", email: item?.email || "", phone: item?.phone || "", active: item ? item.active : true }
      : { name: item?.name || "", branch: item?.branch || "", street: item?.address?.street || "", city: item?.address?.city || "", primary: !!item?.primary, active: item ? item.active : true }
  );
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async () => {
    try {
      const body = isB
        ? { prefixes: f.prefixes, name: f.name, code: f.code, gstin: f.gstin, state: f.state, address: { street: f.street, city: f.city, pincode: f.pincode, country: "India" }, email: f.email, phone: f.phone, active: f.active }
        : { name: f.name, branch: f.branch || null, address: { street: f.street, city: f.city }, primary: f.primary, active: f.active };
      const url = `/${isB ? "branches" : "warehouses"}`;
      if (item) await api.put(`${url}/${item._id}`, body);
      else await api.post(url, body);
      toast("Saved");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal
      open
      title={`${item ? "Edit" : "New"} ${isB ? "Branch" : "Warehouse"}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" required>
          <input value={f.name} onChange={set("name")} autoFocus />
        </Field>
        {isB ? (
          <>
            <div className="row-2">
              <Field label="State" required>
                <select value={f.state} onChange={set("state")}>
                  <option value="">Select</option>
                  {STATES.map(([c, n]) => (
                    <option key={c} value={c}>
                      [{c}] {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="GSTIN">
                <input className="mono" maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
              </Field>
            </div>
            <Field label="Street">
              <input value={f.street} onChange={set("street")} />
            </Field>
            <div className="row-3">
              <Field label="City">
                <input value={f.city} onChange={set("city")} />
              </Field>
              <Field label="PIN Code">
                <input value={f.pincode} onChange={set("pincode")} />
              </Field>
              <Field label="Code">
                <input value={f.code} onChange={set("code")} />
              </Field>
            </div>
            <div className="row-2">
              <Field label="Email">
                <input value={f.email} onChange={set("email")} />
              </Field>
              <Field label="Phone">
                <input value={f.phone} onChange={set("phone")} />
              </Field>
            </div>
            <h4 className="section-title" style={{ margin: "6px 0 0" }}>
              Number Series <span className="muted small">Leave blank to share the head office series</span>
            </h4>
            <div className="row-3">
              {[
                ["invoice", "Invoice"],
                ["creditNote", "Credit Note"],
                ["payment", "Payment Received"],
                ["quote", "Quote"],
                ["salesOrder", "Sales Order"],
                ["purchaseOrder", "Purchase Order"],
                ["vendorCredit", "Vendor Credit"],
                ["vendorPayment", "Payment Made"],
              ].map(([k, l]) => (
                <Field key={k} label={`${l} Prefix`}>
                  <input value={f.prefixes[k] || ""} placeholder={k === "invoice" ? "e.g. DL/INV-" : ""} maxLength={12} onChange={(e) => setF({ ...f, prefixes: { ...f.prefixes, [k]: e.target.value } })} />
                </Field>
              ))}
            </div>
          </>
        ) : (
          <>
            <Field label="Branch">
              <select value={f.branch} onChange={set("branch")}>
                <option value="">Head Office</option>
                {branches.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row-2">
              <Field label="Street">
                <input value={f.street} onChange={set("street")} />
              </Field>
              <Field label="City">
                <input value={f.city} onChange={set("city")} />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.primary} onChange={set("primary")} /> Primary warehouse (stock with no warehouse picked goes here)
            </label>
          </>
        )}
        {item && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={set("active")} /> Active
          </label>
        )}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}
