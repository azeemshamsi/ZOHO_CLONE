import { useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES } from "../lib/constants";
import { Modal, Field, toast } from "./ui";
import Icon from "./Icon";

// Top bar: current company, with a menu to switch to (or add) another company.
export default function CompanySwitcher() {
  const { organization, organizations, switchCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", state: organization?.state || "", gstin: "" });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/companies", f);
      toast(`${data.name} created`);
      await switchCompany(data._id);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  return (
    <div className="company-switch">
      <button className="company-btn" onClick={() => setOpen(!open)}>
        <span className="company-name">{organization?.name}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="company-menu" onMouseLeave={() => setOpen(false)}>
          <div className="label-sm" style={{ padding: "8px 12px 4px" }}>
            Your companies
          </div>
          {(organizations || []).map((o) => (
            <button key={o._id} className={String(o._id) === String(organization?._id) ? "current" : ""} onClick={() => (String(o._id) === String(organization?._id) ? setOpen(false) : switchCompany(o._id))}>
              <span>
                <strong>{o.name}</strong>
                <small className="muted">
                  {o.gstin || "No GSTIN"} · {o.role}
                </small>
              </span>
              {String(o._id) === String(organization?._id) && <Icon name="check" size={16} />}
            </button>
          ))}
          <button
            className="add"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
          >
            <Icon name="plus" size={16} /> Add a company
          </button>
        </div>
      )}
      {adding && (
        <Modal
          open
          title="Add a company"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy || !f.name || !f.state} onClick={create}>
                Create & Open
              </button>
            </>
          }
        >
          <p className="muted small">A separate set of books with its own GSTIN, invoices and reports. You'll be its admin, and you can switch between companies from the top bar.</p>
          <div className="form-grid">
            <Field label="Company name" required>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
            </Field>
            <Field label="State" required>
              <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
                <option value="">Choose</option>
                {STATES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="GSTIN">
              <input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
