import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { STATES } from "../lib/constants";
import { Field, Modal, toast } from "./ui";
import SearchSelect, { partyOptions } from "./SearchSelect";

/**
 * Choose (or add) the customer for a sale: naming a cash sale imported from Tally, or changing an invoice's
 * customer. onDone(customerId, placeOfSupply) does the work; this box only collects the customer.
 */
export default function NameCustomer({ title, intro, needState, busy, onDone, onClose }) {
  const [customers, setCustomers] = useState([]);
  const [customer, setCustomer] = useState("");
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState({ displayName: "", phone: "", gstin: "", state: "" });
  const [pos, setPos] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/customers", { params: { status: "active" } }).then((r) => setCustomers(r.data)).catch(() => {});
  }, []);
  const chosen = customers.find((c) => c._id === customer);
  useEffect(() => {
    if (chosen) setPos(chosen.placeOfSupply || chosen.billingAddress?.state || "");
  }, [customer]);

  const add = async () => {
    setSaving(true);
    try {
      const gstin = n.gstin.trim().toUpperCase();
      const state = n.state || (gstin ? gstin.slice(0, 2) : "");
      const { data } = await api.post("/customers", {
        displayName: n.displayName.trim(),
        customerType: "individual",
        phone: n.phone.trim(),
        gstin,
        gstTreatment: gstin ? "registered" : "consumer",
        ...(state ? { placeOfSupply: state, billingAddress: { state, country: "India" } } : {}),
      });
      setCustomers([...customers, data]);
      setCustomer(data._id);
      setPos(state);
      setAdding(false);
      toast(`Customer ${data.displayName} added`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setSaving(false);
  };

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !customer || (needState && !pos)} onClick={() => onDone(customer, pos)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {intro && <p className="muted small" style={{ margin: 0 }}>{intro}</p>}
        {!adding ? (
          <Field label="Customer" required>
            <SearchSelect
              value={customer}
              options={partyOptions(customers)}
              onChange={setCustomer}
              placeholder="Type to search customers…"
              autoFocus
            />
            <button type="button" className="link-btn small" style={{ marginTop: 6 }} onClick={() => setAdding(true)}>
              + New customer
            </button>
          </Field>
        ) : (
          <div className="card" style={{ padding: 12 }}>
            <div className="row-2">
              <Field label="Name" required>
                <input autoFocus value={n.displayName} onChange={(e) => setN({ ...n, displayName: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input value={n.phone} onChange={(e) => setN({ ...n, phone: e.target.value })} />
              </Field>
            </div>
            <div className="row-2">
              <Field label="GSTIN" hint="Only if registered — the sale then counts as B2B in GSTR-1">
                <input value={n.gstin} maxLength={15} onChange={(e) => setN({ ...n, gstin: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="State">
                <select value={n.state} onChange={(e) => setN({ ...n, state: e.target.value })}>
                  <option value="">{n.gstin.length >= 2 ? "From the GSTIN" : "Choose"}</option>
                  {STATES.map(([c, s]) => (
                    <option key={c} value={c}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving || !n.displayName.trim()} onClick={add}>
                Add customer
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>
                Back
              </button>
            </div>
          </div>
        )}
        {needState && customer && (
          <Field label="Place of supply" required hint="This sale was charged IGST (another state)">
            <select value={pos} onChange={(e) => setPos(e.target.value)}>
              <option value="">Choose</option>
              {STATES.map(([c, s]) => (
                <option key={c} value={c}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
