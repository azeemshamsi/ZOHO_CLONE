import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { STATES } from "../lib/constants";
import { PageHeader, Spinner, Field, Modal, toast } from "../components/ui";

const FIELD_LABEL = {
  email: "API user email",
  password: "API user password",
  token: "API token",
  clientId: "Client ID",
  clientSecret: "Client secret",
  loginId: "Login ID",
  licenceKey: "Licence key",
  apiKey: "API key",
  trackingKey: "Tracking API key (optional)",
  trackingToken: "Tracking access token",
  clientName: "Client name (optional)",
  awbPool: "AWB numbers in stock",
  pincodes: "Serviceable pincodes (blank = all)",
  pickupLocation: "Pickup location name",
  courierId: "Courier ID (optional)",
  autoPickup: "Schedule pickup automatically",
  shippingMode: "Shipping mode",
  customerCode: "Customer code",
  originArea: "Pickup area code",
  productCode: "Service type",
  vendorCode: "Vendor code (optional)",
  serviceType: "Service type",
  commodityId: "Commodity ID (optional)",
};
const OPTIONAL = ["courierId", "vendorCode", "commodityId", "trackingKey", "trackingToken", "productCode", "serviceType", "shippingMode", "autoPickup", "clientName", "awbPool", "pincodes"];
const SELECTS = {
  productCode: [["A", "eTail Apex (air)"], ["E", "eTail Surface (ground)"], ["D", "Domestic Priority"]],
  serviceType: [["B2C SMART EXPRESS", "B2C Smart Express"], ["B2C PRIORITY", "B2C Priority"], ["B2C GROUND ECONOMY", "B2C Ground Economy"], ["GROUND EXPRESS", "Ground Express"], ["PRIORITY", "Priority"], ["STD EXP-A", "Standard Express (air)"]],
  shippingMode: [["Surface", "Surface"], ["Express", "Express"]],
};
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

function Connection({ store, onSaved }) {
  const [f, setF] = useState({ shop: store.shop || "", authType: store.authType || "client", clientId: store.clientId || "", clientSecret: "", accessToken: "", syncFrom: store.syncFrom ? store.syncFrom.slice(0, 10) : "", autoSync: store.autoSync !== false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.put("/shopify/store", { ...f, syncFrom: f.syncFrom || null });
      onSaved(data);
      setF({ ...f, clientSecret: "", accessToken: "" });
      toast(data.connected ? `Connected to ${data.shopName}` : "Saved");
      if (data.connected && !store.lastSyncAt) api.post("/shopify/sync");
    } catch (err) {
      toast(errMsg(err), "error");
      api.get("/shopify/store").then((r) => onSaved(r.data));
    }
    setBusy(false);
  };
  return (
    <form className="card form" onSubmit={save}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Store connection
        <span className={`pill ${store.connected ? "pill-green" : ""}`}>{store.connected ? `Connected · ${store.shopName}` : "Not connected"}</span>
      </h4>
      <div className="form-grid">
        <Field label="Store address" required hint="Your .myshopify.com address, e.g. wooden-twist.myshopify.com">
          <input value={f.shop} onChange={set("shop")} placeholder="your-store.myshopify.com" />
        </Field>
        <Field label="How OrdexaGo connects">
          <select value={f.authType} onChange={set("authType")}>
            <option value="client">App from the Shopify Dev Dashboard (Client ID + secret)</option>
            <option value="token">Older custom app (Admin API access token shpat_…)</option>
          </select>
        </Field>
        {f.authType === "client" ? (
          <>
            <div className="alert alert-info small">
              In <strong>dev.shopify.com/dashboard</strong>: create an app → <em>Versions</em> → add scopes <code>read_orders, read_all_orders, read_products, read_customers, read_inventory, write_inventory, read_locations, read_returns, write_returns, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders</code> → Release → <em>Home → Install</em> on your store. Then copy the Client ID and secret from <em>Settings</em>. The app and the store must be in the same Shopify organization.
            </div>
            <div className="row-2">
              <Field label="Client ID" required>
                <input value={f.clientId} onChange={set("clientId")} autoComplete="off" />
              </Field>
              <Field label="Client secret" required={!store.hasSecret} hint={store.hasSecret ? "Saved. Leave blank to keep it." : ""}>
                <input type="password" value={f.clientSecret} onChange={set("clientSecret")} autoComplete="new-password" />
              </Field>
            </div>
          </>
        ) : (
          <Field label="Admin API access token" required={!store.hasToken} hint={store.hasToken ? "Saved. Leave blank to keep it." : "Shopify admin → Settings → Apps → Develop apps → your app → API credentials"}>
            <input type="password" value={f.accessToken} onChange={set("accessToken")} autoComplete="new-password" placeholder="shpat_…" />
          </Field>
        )}
        <div className="row-2">
          <Field label="Bring in orders from" hint="Orders placed before this date are ignored">
            <input type="date" value={f.syncFrom} onChange={set("syncFrom")} />
          </Field>
          <label className="check" style={{ alignSelf: "end", paddingBottom: 10 }}>
            <input type="checkbox" checked={f.autoSync} onChange={set("autoSync")} /> Sync new orders every 15 minutes
          </label>
        </div>
      </div>
      <div className="form-footer">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Connecting…" : "Save & Connect"}
        </button>
        {store.connected && (
          <button type="button" className="btn btn-ghost" onClick={() => window.confirm("Disconnect Shopify? Orders already in OrdexaGo stay.") && api.delete("/shopify/store").then(() => api.get("/shopify/store").then((r) => onSaved(r.data)))}>
            Disconnect
          </button>
        )}
      </div>
    </form>
  );
}

function Share({ store, onSaved }) {
  const [on, setOn] = useState(store.shareable.filter((c) => c.on).map((c) => String(c._id)));
  const save = async () => {
    try {
      await api.put("/shopify/store/share", { orgs: on });
      toast(on.length ? "Store shared" : "Sharing turned off");
      onSaved({ shareable: store.shareable.map((c) => ({ ...c, on: on.includes(String(c._id)) })) });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="card form" style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>Use this store in your other companies</h4>
      <p className="muted small">The companies ticked here see the same orders and can invoice any of them; the invoice is made in whichever company you're in. Couriers, settings and inventory sync stay with this company.</p>
      {store.shareable.map((c) => (
        <label key={c._id} className="check">
          <input type="checkbox" checked={on.includes(String(c._id))} onChange={(e) => setOn(e.target.checked ? [...on, String(c._id)] : on.filter((x) => x !== String(c._id)))} /> {c.name}
        </label>
      ))}
      <div className="form-footer">
        <button className="btn btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

function Invoicing({ store, onSaved }) {
  const inv = store.invoice || {};
  const [f, setF] = useState({ status: inv.status || "sent", dateFrom: inv.dateFrom || "order", recordPayment: !!inv.recordPayment, paymentAccount: inv.paymentAccount || "", shippingSac: inv.shippingSac || "996812", trackInventory: !!inv.trackInventory });
  const [pkg, setPkg] = useState({ weight: store.pkg?.weight || 0.5, length: store.pkg?.length || 20, breadth: store.pkg?.breadth || 15, height: store.pkg?.height || 10 });
  const [ful, setFul] = useState({ fulfillInShopify: !!store.fulfillInShopify, notifyCustomer: store.notifyCustomer !== false });
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    api.get("/banking/accounts").then((r) => setAccounts(r.data.filter((a) => a.active !== false))).catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.put("/shopify/store", { invoice: f, pkg: Object.fromEntries(Object.entries(pkg).map(([k, v]) => [k, Number(v)])), ...ful });
      onSaved(data);
      toast("Saved");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  return (
    <form className="card form" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>Invoices & shipping</h4>
      <p className="muted small">Shopify prices include GST. OrdexaGo takes the GST out of each price using the item's rate, puts discounts on the lines, adds shipping as a line at the order's highest GST rate, and makes the invoice total match Shopify to the paisa.</p>
      <div className="form-grid">
        <div className="row-3">
          <Field label="New invoices are">
            <select value={f.status} onChange={set("status")}>
              <option value="sent">Saved (posted to the books)</option>
              <option value="draft">Drafts</option>
            </select>
          </Field>
          <Field label="Invoice date">
            <select value={f.dateFrom} onChange={set("dateFrom")}>
              <option value="order">Order date</option>
              <option value="today">Date invoiced</option>
            </select>
          </Field>
          <Field label="SAC for shipping charges">
            <input value={f.shippingSac} onChange={set("shippingSac")} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.recordPayment} onChange={set("recordPayment")} /> Record the payment for prepaid orders that Shopify shows as paid
        </label>
        {f.recordPayment && (
          <Field label="Deposit prepaid payments to" hint="e.g. a Razorpay / Shopify Payments clearing account">
            <select value={f.paymentAccount} onChange={set("paymentAccount")}>
              <option value="">Choose an account</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <label className="check">
          <input type="checkbox" checked={f.trackInventory} onChange={set("trackInventory")} /> Track stock for items created from Shopify
        </label>
        <div className="label-sm">Default package (you can change it when booking)</div>
        <div className="row-4">
          {[
            ["weight", "Weight (kg)"],
            ["length", "Length (cm)"],
            ["breadth", "Breadth (cm)"],
            ["height", "Height (cm)"],
          ].map(([k, l]) => (
            <Field key={k} label={l}>
              <input type="number" step="0.01" value={pkg[k]} onChange={(e) => setPkg({ ...pkg, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={ful.fulfillInShopify} onChange={(e) => setFul({ ...ful, fulfillInShopify: e.target.checked })} /> When a shipment is booked, mark the order fulfilled in Shopify with the tracking number
        </label>
        {ful.fulfillInShopify && (
          <label className="check" style={{ marginLeft: 24 }}>
            <input type="checkbox" checked={ful.notifyCustomer} onChange={(e) => setFul({ ...ful, notifyCustomer: e.target.checked })} /> Shopify emails the customer the tracking details
          </label>
        )}
      </div>
      <div className="form-footer">
        <button className="btn btn-primary">Save</button>
      </div>
    </form>
  );
}

function InventorySync({ store, onSaved }) {
  const [f, setF] = useState({ inventorySync: !!store.inventorySync, locationId: store.locationId || "", stockFrom: store.stockFrom ? store.stockFrom.slice(0, 10) : "", returnCreditNote: store.returnCreditNote !== false });
  const [locs, setLocs] = useState(null);
  useEffect(() => {
    if (store.connected) api.get("/shopify/locations").then((r) => setLocs(r.data)).catch((e) => setLocs({ error: errMsg(e) }));
  }, [store.connected]);
  const save = async (e) => {
    e.preventDefault();
    try {
      const loc = Array.isArray(locs) ? locs.find((l) => l.id === f.locationId) : null;
      if (f.inventorySync && !f.locationId) return toast("Choose the Shopify location to update", "error");
      const { data } = await api.put("/shopify/store", { ...f, locationName: loc?.name || store.locationName || "", stockFrom: f.stockFrom || null });
      onSaved(data);
      toast(f.inventorySync ? "Inventory sync on — sending stock to Shopify" : "Saved");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  const ps = store.pushStatus;
  return (
    <form className="card form" id="inventory" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Inventory sync & returns
        <span className={`pill ${store.inventorySync ? "pill-green" : ""}`}>{store.inventorySync ? "Syncing" : "Off"}</span>
      </h4>
      <p className="muted small">
        OrdexaGo sends each item's Shopify quantity whenever stock changes: in stock − reserved by open Shopify orders − buffer, plus virtual (made-to-order) stock. Linked listings get their main item's quantity. Needs the <code>read_locations</code>, <code>write_inventory</code> and (for returns) <code>read_returns, write_returns</code> scopes.
      </p>
      <div className="form-grid">
        <label className="switch-row">
          <span className="toggle">
            <input type="checkbox" checked={f.inventorySync} onChange={(e) => setF({ ...f, inventorySync: e.target.checked })} />
            <span />
          </span>
          <span>Sync inventory from OrdexaGo to Shopify</span>
        </label>
        <div className="row-2">
          <Field label="Shopify location to update">
            {locs?.error ? (
              <div className="text-red small">{locs.error}</div>
            ) : (
              <select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>
                <option value="">Choose…</option>
                {(Array.isArray(locs) ? locs : []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Orders reserve stock from" hint="Shopify orders from this date hold stock until invoiced">
            <input type="date" value={f.stockFrom} onChange={(e) => setF({ ...f, stockFrom: e.target.value })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.returnCreditNote} onChange={(e) => setF({ ...f, returnCreditNote: e.target.checked })} /> When a return is closed on an invoiced order, create a credit note (puts the stock back)
        </label>
        {ps?.at && (
          <p className="muted small">
            Last sent {new Date(ps.at).toLocaleString("en-IN")}: {ps.pushed} quantities{ps.errors?.length ? <span className="text-red"> · {ps.errors.slice(0, 3).join("; ")}</span> : ""}
          </p>
        )}
        {store.webhooks?.length > 0 && <p className="muted small">Real-time order updates from Shopify are on.</p>}
      </div>
      <div className="form-footer">
        <button className="btn btn-primary">Save</button>
      </div>
    </form>
  );
}

function Rules({ store, onSaved }) {
  const [rules, setRules] = useState(store.rules.map((r) => ({ ...r, hsnPrefixes: r.hsnPrefixes.join(", "), keywords: r.keywords.join(", ") })));
  const [fallback, setFallback] = useState(store.fallbackTaxRate ?? 18);
  const [test, setTest] = useState({ title: "Sheesham Wood Coffee Table", productType: "", hsn: "", shopifyTaxRate: "" });
  const [result, setResult] = useState(null);
  const out = () => rules.map((r) => ({ name: r.name, taxRate: Number(r.taxRate), defaultHsn: r.defaultHsn, hsnPrefixes: list(r.hsnPrefixes), keywords: list(r.keywords) }));
  const upd = (i, k) => (e) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const save = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.put("/shopify/store", { rules: out(), fallbackTaxRate: Number(fallback) });
      onSaved(data);
      toast("GST rules saved");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  const run = async () => {
    try {
      const { data } = await api.post("/shopify/rules/test", { ...test, shopifyTaxRate: test.shopifyTaxRate === "" ? null : Number(test.shopifyTaxRate), rules: out() });
      setResult(data);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  return (
    <form className="card form" onSubmit={save} style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>GST & HSN rules for new items</h4>
      <p className="muted small">
        When a Shopify product becomes an item, OrdexaGo finds its category from the product type, Shopify category, tags or title (rules are checked top to bottom). The category sets the GST rate; a Shopify HSN that's missing, invalid or from another category is replaced by the category's default HSN. Anything changed is flagged under <Link to="/shopify-orders">Review items</Link>. Items that already exist keep their HSN and rate.
      </p>
      <table className="table compact rules-table">
        <thead>
          <tr>
            <th>Category</th>
            <th style={{ width: 80 }}>GST %</th>
            <th style={{ width: 100 }}>Default HSN</th>
            <th>HSN codes in this category</th>
            <th>Words that identify it</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i}>
              <td>
                <input value={r.name} onChange={upd(i, "name")} />
              </td>
              <td>
                <input type="number" value={r.taxRate} onChange={upd(i, "taxRate")} />
              </td>
              <td>
                <input value={r.defaultHsn} onChange={upd(i, "defaultHsn")} />
              </td>
              <td>
                <textarea rows={2} value={r.hsnPrefixes} onChange={upd(i, "hsnPrefixes")} />
              </td>
              <td>
                <textarea rows={3} value={r.keywords} onChange={upd(i, "keywords")} />
              </td>
              <td className="row-btns">
                <button type="button" className="btn btn-sm btn-ghost" title="Move up" disabled={!i} onClick={() => setRules(rules.map((x, j) => (j === i - 1 ? rules[i] : j === i ? rules[i - 1] : x)))}>
                  ↑
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button type="button" className="btn btn-sm" onClick={() => setRules([...rules, { name: "", taxRate: 18, defaultHsn: "", hsnPrefixes: "", keywords: "" }])}>
          + Add category
        </button>
        <Field label="GST % when no category matches">
          <input type="number" value={fallback} onChange={(e) => setFallback(e.target.value)} style={{ width: 90 }} />
        </Field>
      </div>
      <div className="rule-test">
        <div className="label-sm">Try a product</div>
        <div className="row-4">
          <input value={test.title} onChange={(e) => setTest({ ...test, title: e.target.value })} placeholder="Product title" />
          <input value={test.productType} onChange={(e) => setTest({ ...test, productType: e.target.value })} placeholder="Product type" />
          <input value={test.hsn} onChange={(e) => setTest({ ...test, hsn: e.target.value })} placeholder="HSN in Shopify" />
          <input type="number" value={test.shopifyTaxRate} onChange={(e) => setTest({ ...test, shopifyTaxRate: e.target.value })} placeholder="GST % in Shopify" />
        </div>
        <button type="button" className="btn btn-sm" onClick={run} style={{ marginTop: 8 }}>
          Check
        </button>
        {result && (
          <div className="muted small" style={{ marginTop: 8 }}>
            <strong>{result.category || "No category"}</strong> → HSN {result.hsn || "—"}, GST {result.taxRate}%{result.notes.length ? ` · ${result.notes.join("; ")}` : " · no changes"}
          </div>
        )}
      </div>
      <div className="form-footer">
        <button className="btn btn-primary">Save Rules</button>
      </div>
    </form>
  );
}

function CourierModal({ acc, carriers, onClose, onSaved }) {
  const isNew = !acc._id;
  const [f, setF] = useState({ carrier: acc.carrier || "shiprocket", name: acc.name || "", active: acc.active !== false, isDefault: !!acc.isDefault, test: !!acc.test, baseUrl: acc.baseUrl || "", credentials: {}, options: { ...(acc.options || {}) }, pickup: { name: "", phone: "", address: "", city: "", state: "", pincode: "", ...(acc.pickup || {}) }, trackingUrl: acc.trackingUrl || "" });
  const [busy, setBusy] = useState(false);
  const c = carriers[f.carrier];
  const saved = acc.credentialKeys || [];
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, name: f.name || c.label };
      const { data } = isNew ? await api.post("/shopify/couriers", body) : await api.put(`/shopify/couriers/${acc._id}`, body);
      if (f.carrier !== "custom") {
        try {
          const t = await api.post(`/shopify/couriers/${data._id}/test`);
          toast(t.data.message);
        } catch (err) {
          toast(errMsg(err), "error");
        }
      } else toast("Courier saved");
      onSaved();
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const setP = (k) => (e) => setF({ ...f, pickup: { ...f.pickup, [k]: e.target.value } });
  const setO = (k, v) => setF((x) => ({ ...x, options: { ...x.options, [k]: v } }));
  const [warehouses, setWarehouses] = useState([]);
  useEffect(() => {
    api.get("/warehouses").then((r) => setWarehouses(r.data.filter((w) => w.active !== false && w.address?.pincode))).catch(() => {});
  }, []);
  const fromWarehouse = (id) => {
    const w = warehouses.find((x) => x._id === id);
    if (w) setF((x) => ({ ...x, pickup: { ...x.pickup, name: w.name, address: w.address.street || "", city: w.address.city || "", state: w.address.state || "", pincode: w.address.pincode || "" } }));
  };
  return (
    <Modal
      open
      wide
      title={isNew ? "Add courier" : `Edit ${acc.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save & Test"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-2">
          <Field label="Courier">
            <select value={f.carrier} disabled={!isNew} onChange={(e) => setF({ ...f, carrier: e.target.value, credentials: {}, options: {} })}>
              {Object.entries(carriers).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name in OrdexaGo">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={c.label} />
          </Field>
        </div>
        <p className="muted small">{c.help}</p>
        {c.fields.credentials.length > 0 && (
          <div className="row-2">
            {c.fields.credentials.map((k) => (
              <Field key={k} label={FIELD_LABEL[k] || k} required={!OPTIONAL.includes(k) && !saved.includes(k)} hint={saved.includes(k) ? "Saved. Leave blank to keep it." : ""}>
                <input type={/pass|secret|key|token/i.test(k) ? "password" : "text"} autoComplete="new-password" value={f.credentials[k] || ""} onChange={(e) => setF({ ...f, credentials: { ...f.credentials, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
        )}
        {c.fields.options.filter((k) => !["awbPool", "pincodes"].includes(k)).length > 0 && (
          <div className="row-2">
            {c.fields.options
              .filter((k) => !["awbPool", "pincodes"].includes(k))
              .map((k) =>
                k === "autoPickup" ? (
                  <label key={k} className="check" style={{ alignSelf: "end" }}>
                    <input type="checkbox" checked={!!f.options[k]} onChange={(e) => setO(k, e.target.checked)} /> {FIELD_LABEL[k]}
                  </label>
                ) : SELECTS[k] ? (
                  <Field key={k} label={FIELD_LABEL[k]}>
                    <select value={f.options[k] || SELECTS[k][0][0]} onChange={(e) => setO(k, e.target.value)}>
                      {SELECTS[k].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field key={k} label={FIELD_LABEL[k] || k} required={!OPTIONAL.includes(k)}>
                    <input value={f.options[k] || ""} onChange={(e) => setO(k, e.target.value)} />
                  </Field>
                )
              )}
          </div>
        )}
        {f.carrier === "custom" && (
          <div className="row-2">
            <Field label={FIELD_LABEL.awbPool} hint={`${String(f.options.awbPool || "").split(/[\s,;]+/).filter(Boolean).length} left · one per line, used in order when you book. Paste or upload a CSV/TXT.`}>
              <textarea rows={5} value={f.options.awbPool || ""} onChange={(e) => setO("awbPool", e.target.value)} placeholder={"SELF000101\nSELF000102"} />
              <input type="file" accept=".csv,.txt" style={{ marginTop: 6 }} onChange={async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const found = (await file.text()).split(/[\r\n,;\t]+/).map((x) => x.trim().replace(/^"|"$/g, "")).filter((x) => x && !/awb/i.test(x));
                setO("awbPool", [...String(f.options.awbPool || "").split(/\s+/).filter(Boolean), ...found].join("\n"));
                toast(`${found.length} AWB numbers added — save to keep them`);
              }} />
            </Field>
            <Field label={FIELD_LABEL.pincodes} hint="Separate with commas or new lines">
              <textarea rows={5} value={f.options.pincodes || ""} onChange={(e) => setO("pincodes", e.target.value)} />
            </Field>
          </div>
        )}
        <div className="row-3">
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" checked={f.options.codEnabled !== false} onChange={(e) => setO("codEnabled", e.target.checked)} /> COD enabled
          </label>
          <Field label="Label format (OrdexaGo labels)">
            <select value={f.options.labelFormat || "4x6"} onChange={(e) => setO("labelFormat", e.target.value)}>
              <option value="4x6">4x6 thermal</option>
              <option value="a4">A4 (4 per page)</option>
            </select>
          </Field>
          <Field label="Text printed on labels" hint={`${String(f.options.customText || "").length}/150`}>
            <input maxLength={150} value={f.options.customText || ""} onChange={(e) => setO("customText", e.target.value)} placeholder="Thank you for shopping with us!" />
          </Field>
        </div>
        {f.carrier === "custom" ? (
          <Field label="Tracking link" hint="Use {awb} where the tracking number goes">
            <input value={f.trackingUrl} onChange={(e) => setF({ ...f, trackingUrl: e.target.value })} placeholder="https://courier.example/track?awb={awb}" />
          </Field>
        ) : (
          <>
            <div className="label-sm">Pickup / return address</div>
            {warehouses.length > 0 && (
              <Field label="Fill from a warehouse">
                <select value="" onChange={(e) => fromWarehouse(e.target.value)}>
                  <option value="">Choose a warehouse…</option>
                  {warehouses.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name} — {w.address.city} {w.address.pincode}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="row-2">
              <Field label="Contact name">
                <input value={f.pickup.name} onChange={setP("name")} />
              </Field>
              <Field label="Phone">
                <input value={f.pickup.phone} onChange={setP("phone")} />
              </Field>
            </div>
            <Field label="Address">
              <input value={f.pickup.address} onChange={setP("address")} />
            </Field>
            <div className="row-3">
              <Field label="City">
                <input value={f.pickup.city} onChange={setP("city")} />
              </Field>
              <Field label="State">
                <select value={f.pickup.state} onChange={setP("state")}>
                  <option value="">Choose</option>
                  {STATES.map(([code, n]) => (
                    <option key={code} value={code}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Pincode">
                <input value={f.pickup.pincode} onChange={setP("pincode")} />
              </Field>
            </div>
            <div className="row-2">
              <label className="check">
                <input type="checkbox" checked={f.test} onChange={(e) => setF({ ...f, test: e.target.checked })} /> Use the courier's test (staging) system
              </label>
              <Field label="API address (optional)" hint="Only if the courier gave you a different one">
                <input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
              </Field>
            </div>
          </>
        )}
        <div className="row-2">
          <label className="check">
            <input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Default courier
          </label>
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
          </label>
        </div>
      </div>
    </Modal>
  );
}

function Couriers({ carriers }) {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/shopify/couriers").then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="card form" id="couriers" style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Couriers
        <button className="btn btn-sm btn-primary" onClick={() => setEdit({})}>
          + Add Courier
        </button>
      </h4>
      <p className="muted small">Book shipments straight from an order: Shiprocket, Delhivery, Blue Dart, DTDC, Shadowfax, or any other courier with a manually entered AWB.</p>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <p className="muted">No couriers yet.</p>
      ) : (
        <table className="table compact table-click">
          <tbody>
            {rows.map((a) => (
              <tr key={a._id} onClick={() => setEdit(a)} className={a.active ? "" : "muted"}>
                <td>
                  <strong>{a.name}</strong> {a.isDefault && <span className="pill pill-green">Default</span>} {a.test && <span className="pill pill-amber">Test</span>} {!a.active && <span className="pill">Inactive</span>}
                </td>
                <td>{carriers[a.carrier]?.label}</td>
                <td className="muted small">
                  {a.carrier === "custom" ? `${String(a.options?.awbPool || "").split(/\s+/).filter(Boolean).length} AWBs in stock` : a.pickup?.pincode ? `Pickup ${a.pickup.city || ""} ${a.pickup.pincode}` : "No pickup address"}
                  {" · "}
                  {a.options?.codEnabled === false ? "Prepaid only" : "COD"} · {a.options?.labelFormat === "a4" ? "A4" : "4x6"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <CourierModal
          acc={edit}
          carriers={carriers}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
    </div>
  );
}

export function ShopifySettings() {
  const [store, setStore] = useState(null);
  useEffect(() => {
    api.get("/shopify/store").then((r) => setStore(r.data));
  }, []);
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (store && h) setTimeout(() => document.getElementById(h)?.scrollIntoView({ behavior: "smooth" }), 250);
  }, [!!store]);
  if (!store) return <Spinner />;
  const saved = (d) => setStore({ ...store, ...d, carriers: store.carriers, rules: d.rules || store.rules, shareable: d.shareable || store.shareable, shared: store.shared });
  if (store.shared)
    return (
      <>
        <PageHeader title="Store Settings" back="/shopify-orders" />
        <div className="card">
          <p>
            This company uses the Shopify store <strong>{store.shopName}</strong> shared from <strong>{store.ownerName}</strong>. Orders, couriers and store settings are managed in {store.ownerName}; invoices you create here are made in this company.
          </p>
          <p className="muted small">To change settings or stop sharing, switch to {store.ownerName} from the company menu at the top.</p>
        </div>
      </>
    );
  return (
    <>
      <PageHeader title="Store Settings" back="/shopify-orders" subtitle="Connect your store, set how orders become invoices, GST rules for new items, and couriers." />
      <Connection store={store} onSaved={saved} />
      {store.connected && store.shareable?.length > 0 && <Share store={store} onSaved={saved} />}
      <Invoicing store={store} onSaved={saved} />
      <InventorySync store={store} onSaved={saved} />
      <Rules key={JSON.stringify(store.rules).length} store={store} onSaved={saved} />
      <Couriers carriers={store.carriers} />
    </>
  );
}
