import { Fragment, useEffect, useState } from "react";
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
  const [ful, setFul] = useState({ fulfillInShopify: !!store.fulfillInShopify, notifyCustomer: store.notifyCustomer !== false });
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    api.get("/banking/accounts").then((r) => setAccounts(r.data.filter((a) => a.active !== false))).catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.put("/shopify/store", { invoice: f, ...ful });
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
        <p className="muted small">
          Package weight and size come from each product's package type — set them up under <Link to="/package-types">Store → Package Types</Link>.
        </p>
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
          <input type="checkbox" checked={f.returnCreditNote} onChange={(e) => setF({ ...f, returnCreditNote: e.target.checked })} /> When a return is closed on an invoiced order, create a credit note (stock comes back into OrdexaGo only for items with Shopify sync on, while inventory sync is on)
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
  const [f, setF] = useState({ carrier: acc.carrier || "shiprocket", name: acc.name || "", active: acc.active !== false, isDefault: !!acc.isDefault, test: !!acc.test, baseUrl: acc.baseUrl || "", credentials: {}, options: { ...(acc.options || {}) }, pickup: { name: "", phone: "", address: "", city: "", state: "", pincode: "", ...(acc.pickup || {}) }, trackingUrl: acc.trackingUrl || "", rateCard: asRateCard(acc.rateCard) });
  const [busy, setBusy] = useState(false);
  const c = carriers[f.carrier];
  const saved = acc.credentialKeys || [];
  const save = async () => {
    setBusy(true);
    try {
      // A dropdown shows its first choice when nothing is saved: save that choice too, so what you see is what's used.
      const options = { ...f.options };
      for (const k of c.fields.options) if (SELECTS[k] && !options[k]) options[k] = SELECTS[k][0][0];
      const body = { ...f, options, name: f.name || c.label, rateCard: cleanRateCard(f.rateCard, FLAT_CARRIERS.includes(f.carrier)) };
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
        <RateCard rc={f.rateCard} flat={FLAT_CARRIERS.includes(f.carrier)} onChange={(rateCard) => setF((x) => ({ ...x, rateCard }))} />
        {f.rateCard.enabled && (isNew ? <p className="muted small">Save the courier first, then upload its pincode lists.</p> : <PincodeLists acc={acc} flat={FLAT_CARRIERS.includes(f.carrier)} />)}
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

// Drop blank slabs/zones before saving.
const cleanSlabs = (sl) => (sl || []).filter((s) => Number(s.up_to_kg) > 0 && s.price !== "" && s.price !== undefined).map((s) => ({ up_to_kg: Number(s.up_to_kg), price: Number(s.price) }));
// A flat card has only slabs + excess per kg, and fuel / docket / COD / custom charges / GST.
const FLAT_DROP = ["ecc_charge", "ecc_slabs", "ecc_districts", "owsp_slabs", "ras_states", "ras_per_kg", "idc_pct", "efss_pct", "fov_pct"];
const cleanRateCard = (rc, flat) => (flat ? cleanFull({ ...rc, rate_type: "slab", extras: Object.fromEntries(Object.entries(rc.extras || {}).filter(([k]) => !FLAT_DROP.includes(k))) }) : cleanFull(rc));
const cleanFull = (rc) => ({
  ...rc,
  zones: (rc.zones || []).filter((z) => z.zone).map((z) => ({ ...z, slabs: cleanSlabs(z.slabs), additional_per_kg: Number(z.additional_per_kg) || 0, per_kg_rate: Number(z.per_kg_rate) || 0 })),
  extras: { ...(rc.extras || {}), ecc_slabs: cleanSlabs(rc.extras?.ecc_slabs), owsp_slabs: cleanSlabs(rc.extras?.owsp_slabs) },
});
const EMPTY_RC = { enabled: false, rate_type: "slab", volumetric_divisor: 5000, default_zone: "", zones: [], extras: { gst_pct: 18 } };
const asRateCard = (rc) => (rc && Array.isArray(rc.zones) ? { ...EMPTY_RC, ...rc, extras: { ...EMPTY_RC.extras, ...(rc.extras || {}) } } : { ...EMPTY_RC });
const n = (v) => (v === "" || v === null || v === undefined ? "" : Number(v));

function Slabs({ slabs = [], onChange, unit = "₹" }) {
  const set = (i, k, v) => onChange(slabs.map((s, j) => (j === i ? { ...s, [k]: n(v) } : s)));
  return (
    <div>
      {slabs.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <span className="muted small">up to</span>
          <input type="number" step="0.01" min="0" style={{ width: 80 }} value={s.up_to_kg ?? ""} onChange={(e) => set(i, "up_to_kg", e.target.value)} />
          <span className="muted small">kg {unit}</span>
          <input type="number" step="0.01" min="0" style={{ width: 90 }} value={s.price ?? ""} onChange={(e) => set(i, "price", e.target.value)} />
          <button type="button" className="link-btn" onClick={() => onChange(slabs.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="link-btn small" onClick={() => onChange([...slabs, { up_to_kg: "", price: "" }])}>
        + slab
      </button>
    </div>
  );
}

// Rate card in the same format as the Maganova/BillFlow shipping calculator.
// DTDC, Shadowfax and custom couriers use a flat rate card: weight slabs per zone + excess ₹/kg above the last slab.
const FLAT_CARRIERS = ["dtdc", "shadowfax", "custom"];

function FlatZones({ rc, set, setZone }) {
  const zones = rc.zones || [];
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "10px 0 6px" }}>
        <div className="label-sm" style={{ margin: 0 }}>
          Zones &amp; rates
        </div>
        <button type="button" className="btn btn-sm" onClick={() => set("zones", [...zones, { zone: String.fromCharCode(65 + zones.length), slabs: [{ up_to_kg: "", price: "" }], additional_per_kg: 0 }])}>
          + Add Zone
        </button>
      </div>
      {zones.map((z, i) => {
        const slabs = z.slabs || [];
        const setSlab = (j, k, v) => setZone(i, { ...z, slabs: slabs.map((x, m) => (m === j ? { ...x, [k]: n(v) } : x)) });
        return (
          <div key={i} className="card" style={{ padding: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <input style={{ width: 160 }} value={z.zone || ""} placeholder="Zone" onChange={(e) => setZone(i, { ...z, zone: e.target.value.trim() })} />
              <button type="button" className="link-btn text-red" title="Delete zone" onClick={() => set("zones", zones.filter((_, j) => j !== i))}>
                Delete zone
              </button>
            </div>
            {slabs.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginTop: 10, alignItems: "end" }}>
                <div className="muted small">UP TO (KG)</div>
                <div className="muted small">PRICE (₹)</div>
                <div />
                {slabs.map((sl, j) => (
                  <Fragment key={j}>
                    <input type="number" step="0.01" min="0" value={sl.up_to_kg ?? ""} onChange={(e) => setSlab(j, "up_to_kg", e.target.value)} />
                    <input type="number" step="0.01" min="0" value={sl.price ?? ""} onChange={(e) => setSlab(j, "price", e.target.value)} />
                    <button type="button" className="link-btn text-red" title="Delete slab" onClick={() => setZone(i, { ...z, slabs: slabs.filter((_, m) => m !== j) })}>
                      ✕
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10, padding: 8, border: "1px solid var(--border, #e5e7eb)", borderRadius: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => setZone(i, { ...z, slabs: [...slabs, { up_to_kg: "", price: "" }] })}>
                + Slab
              </button>
              <span className="small">
                <strong>Excess weight above last slab: ₹</strong>
              </span>
              <input type="number" step="0.01" min="0" style={{ width: 100 }} value={z.additional_per_kg ?? ""} onChange={(e) => setZone(i, { ...z, additional_per_kg: n(e.target.value) })} />
              <span className="small">per kg</span>
            </div>
          </div>
        );
      })}
      <p className="muted small" style={{ fontStyle: "italic" }}>
        Rule: for any weight, we charge the cheaper of (flat slab price) OR (previous slab + excess × per-kg). Example: slabs 24kg=₹475, 42kg=₹550, per-kg=₹19 → for 30kg we take ₹550 (slab 2) instead of ₹475 + 6×₹19 = ₹589.
      </p>
      <Field label="Default Zone (used when pincode list is empty)" hint="If you haven't uploaded a pincode-zone list for this courier, all pincodes are treated as serviceable at this zone's rate.">
        <select value={rc.default_zone || ""} onChange={(e) => set("default_zone", e.target.value)}>
          <option value="">No default zone</option>
          {zones
            .filter((z) => z.zone)
            .map((z) => (
              <option key={z.zone} value={z.zone}>
                Zone {z.zone}
              </option>
            ))}
        </select>
      </Field>
    </>
  );
}

function RateCard({ rc, onChange, flat }) {
  const [paste, setPaste] = useState(null);
  const x = rc.extras || {};
  const set = (k, v) => onChange({ ...rc, [k]: v });
  const setX = (k, v) => onChange({ ...rc, extras: { ...x, [k]: v } });
  const num = (k) => ({ type: "number", step: "0.01", min: "0", value: x[k] ?? "", onChange: (e) => setX(k, n(e.target.value)) });
  const setZone = (i, z) => set("zones", rc.zones.map((y, j) => (j === i ? z : y)));
  const importJson = () => {
    try {
      const j = JSON.parse(paste);
      const src = j.rateCard || j;
      if (!Array.isArray(src.zones)) throw new Error("No zones found in it");
      onChange(asRateCard({ enabled: true, rate_type: src.rate_type || "slab", volumetric_divisor: src.volumetric_divisor || 5000, default_zone: src.default_zone || "", zones: src.zones, extras: src.extras || {} }));
      setPaste(null);
      toast(`Rate card loaded: ${src.zones.length} zones — save to keep it`);
    } catch (e) {
      toast(`Couldn't read that: ${e.message}`, "error");
    }
  };
  return (
    <div className="card" style={{ background: "var(--bg-soft, #f8fafc)", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label className="check">
          <input type="checkbox" checked={!!rc.enabled} onChange={(e) => set("enabled", e.target.checked)} /> <strong>Rate card</strong> — used when the courier's API gives no charge
        </label>
        <button type="button" className="btn btn-sm" onClick={() => setPaste("")}>
          Paste JSON from other app
        </button>
      </div>
      {paste !== null && (
        <div style={{ marginTop: 8 }}>
          <textarea rows={6} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} placeholder='{"rate_type":"slab","volumetric_divisor":5000,"default_zone":"A","zones":[…],"extras":{…}}' value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={importJson}>
              Load
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPaste(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {rc.enabled && (
        <>
          {flat ? (
            <>
              <Field label="Volumetric divisor" hint="DTDC 5000">
                <input type="number" min="1" value={rc.volumetric_divisor ?? ""} onChange={(e) => set("volumetric_divisor", n(e.target.value))} />
              </Field>
              <FlatZones rc={rc} set={set} setZone={setZone} />
            </>
          ) : (
          <>
          <p className="muted small">
            Chargeable weight = the higher of dead weight and L×B×H ÷ divisor, rounded up to a whole kg. Slab rates charge the cheapest of: a slab's price (weight within it) or its price + extra kg × additional per kg. Then fuel, docket, ECC, OWSP, RAS, IDC, EFSS, FOV, custom charges and COD (higher of flat or %), and GST on the total.
          </p>
          <div className="row-3">
            <Field label="Rate type">
              <select value={rc.rate_type} onChange={(e) => set("rate_type", e.target.value)}>
                <option value="slab">Weight slabs</option>
                <option value="per_kg">Flat per kg</option>
              </select>
            </Field>
            <Field label="Volumetric divisor" hint="Delhivery/DTDC 5000, Blue Dart 4500">
              <input type="number" min="1" value={rc.volumetric_divisor ?? ""} onChange={(e) => set("volumetric_divisor", n(e.target.value))} />
            </Field>
            <Field label="Default zone" hint="Used when no pincode list is uploaded">
              <input value={rc.default_zone || ""} onChange={(e) => set("default_zone", e.target.value.trim())} placeholder="e.g. A" />
            </Field>
          </div>
          <div className="label-sm">Zones</div>
          <table className="table compact">
            <thead>
              <tr>
                <th>Zone</th>
                <th>{rc.rate_type === "per_kg" ? "₹ per kg" : "Slabs"}</th>
                {rc.rate_type !== "per_kg" && <th>Additional ₹/kg</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rc.zones.map((z, i) => (
                <tr key={i}>
                  <td>
                    <input style={{ width: 70 }} value={z.zone || ""} onChange={(e) => setZone(i, { ...z, zone: e.target.value.trim() })} />
                  </td>
                  <td>
                    {rc.rate_type === "per_kg" ? (
                      <input type="number" step="0.01" min="0" style={{ width: 90 }} value={z.per_kg_rate ?? ""} onChange={(e) => setZone(i, { ...z, per_kg_rate: n(e.target.value) })} />
                    ) : (
                      <Slabs slabs={z.slabs || []} onChange={(slabs) => setZone(i, { ...z, slabs })} />
                    )}
                  </td>
                  {rc.rate_type !== "per_kg" && (
                    <td>
                      <input type="number" step="0.01" min="0" style={{ width: 80 }} value={z.additional_per_kg ?? ""} onChange={(e) => setZone(i, { ...z, additional_per_kg: n(e.target.value) })} />
                    </td>
                  )}
                  <td>
                    <button type="button" className="link-btn" onClick={() => set("zones", rc.zones.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm" onClick={() => set("zones", [...rc.zones, { zone: String.fromCharCode(65 + rc.zones.length), slabs: [], additional_per_kg: 0, per_kg_rate: 0 }])}>
            + Add zone
          </button>
          </>
          )}

          <div className="label-sm" style={{ marginTop: 12 }}>
            Surcharges
          </div>
          <div className="row-4">
            <Field label="Fuel surcharge %">
              <input {...num("fuel_surcharge_pct")} />
            </Field>
            <Field label="Docket ₹">
              <input {...num("docket_charge")} />
            </Field>
            {!flat && (
              <>
                <Field label="IDC % of freight">
                  <input {...num("idc_pct")} />
                </Field>
                <Field label="EFSS % of freight">
                  <input {...num("efss_pct")} />
                </Field>
              </>
            )}
          </div>
          <div className="row-4">
            {!flat && (
              <Field label="FOV % of order value">
                <input {...num("fov_pct")} />
              </Field>
            )}
            <Field label="COD flat ₹">
              <input {...num("cod_flat")} />
            </Field>
            <Field label="COD % of order value" hint="Higher of flat or %">
              <input {...num("cod_pct")} />
            </Field>
            <Field label="GST %">
              <input {...num("gst_pct")} />
            </Field>
          </div>
          {!flat && (
          <>
          <div className="row-2">
            <Field label="ECC districts" hint="One per line: State | District. Aliases like “Gautam Buddha Nagar (Noida)” work.">
              <textarea
                rows={4}
                value={(x.ecc_districts || []).map((e) => (e.state ? `${e.state} | ${e.district}` : e.district)).join("\n")}
                onChange={(e) =>
                  setX(
                    "ecc_districts",
                    e.target.value
                      .split("\n")
                      .map((l) => l.split("|").map((t) => t.trim()))
                      .filter((p) => p.some(Boolean))
                      .map((p) => (p.length > 1 ? { state: p[0], district: p[1] } : { state: "", district: p[0] }))
                  )
                }
              />
            </Field>
            <Field label="ECC charge by weight" hint="Charged when the district (or pincode) is in the ECC list">
              <Slabs slabs={x.ecc_slabs || []} onChange={(v) => setX("ecc_slabs", v)} />
              <div className="muted small" style={{ marginTop: 4 }}>
                Flat ECC ₹ (no slabs / no list set):{" "}
                <input style={{ width: 80 }} {...num("ecc_charge")} />
              </div>
            </Field>
          </div>
          <div className="row-2">
            <Field label="OWSP (over-weight surcharge)" hint="By chargeable weight, on every shipment">
              <Slabs slabs={x.owsp_slabs || []} onChange={(v) => setX("owsp_slabs", v)} />
            </Field>
            <Field label="RAS states" hint="Comma or line separated state names">
              <textarea rows={3} value={(x.ras_states || []).join(", ")} onChange={(e) => setX("ras_states", e.target.value.split(/[,\n]+/).map((t) => t.trim()).filter(Boolean))} />
              <div className="muted small" style={{ marginTop: 4 }}>
                RAS ₹ per kg: <input style={{ width: 80 }} {...num("ras_per_kg")} />
              </div>
            </Field>
          </div>
          </>
          )}
          {[1, 2].map((k) => (
            <div className="row-3" key={k}>
              <Field label={`Custom charge ${k} — label`}>
                <input value={x[`custom${k}_label`] || ""} onChange={(e) => setX(`custom${k}_label`, e.target.value)} />
              </Field>
              <Field label="Type">
                <select value={x[`custom${k}_type`] || "fixed"} onChange={(e) => setX(`custom${k}_type`, e.target.value)}>
                  <option value="fixed">Fixed ₹</option>
                  <option value="pct_freight">% of freight</option>
                  <option value="pct_value">% of order value</option>
                </select>
              </Field>
              <Field label="Value">
                <input {...num(`custom${k}_value`)} />
              </Field>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Upload the courier's pincode lists: zones (pincode, zone), EDL and ECC pincodes.
function PincodeLists({ acc, flat }) {
  const [c, setC] = useState(null);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState("");
  const load = () => api.get(`/shopify/couriers/${acc._id}/pincodes`).then((r) => setC(r.data));
  useEffect(() => {
    load().catch(() => {});
  }, [acc._id]);
  const upload = async (kind, file) => {
    if (!file) return;
    setBusy(kind);
    try {
      const rows = (await file.text())
        .split(/\r?\n/)
        .map((l) => l.split(/[,;\t]/).map((t) => t.trim().replace(/^"|"$/g, "")))
        .filter((p) => /^\d{6}$/.test(p[0]))
        .map((p) => ({ pincode: p[0], zone: kind === "zone" ? p[1] || "" : "" }));
      if (!rows.length) throw new Error("No 6-digit pincodes found in the first column");
      let added = 0;
      for (let i = 0; i < rows.length; i += 20000) {
        const { data } = await api.post(`/shopify/couriers/${acc._id}/pincodes`, { kind, replace: replace && i === 0, rows: rows.slice(i, i + 20000) });
        added += data.added;
      }
      toast(`${added} pincodes uploaded`);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  const clear = async (kind) => {
    if (!window.confirm("Remove this whole list?")) return;
    await api.delete(`/shopify/couriers/${acc._id}/pincodes/${kind}`);
    load();
  };
  const KINDS = [
    ["zone", "Pincode → zone", "CSV: pincode, zone. With a list, pincodes not in it are not serviceable."],
    ["edl", "EDL (out of delivery area)", "CSV: one pincode per line. Shown as EDL on the quote."],
    ["ecc", "ECC pincodes", "Optional, instead of ECC districts."],
  ];
  return (
    <div>
      <div className="label-sm">Pincode lists</div>
      <table className="table compact">
        <tbody>
          {KINDS.filter(([k]) => !(flat && k === "ecc")).map(([k, l, h]) => (
            <tr key={k}>
              <td>
                <strong>{l}</strong>
                <div className="muted small">{h}</div>
              </td>
              <td className="small">
                {c ? `${c[k]} pincodes` : "…"}
                {k === "zone" && c && Object.keys(c.zones).length > 0 && (
                  <div className="muted small">
                    {Object.entries(c.zones)
                      .map(([z, v]) => `${z}: ${v}`)
                      .join(" · ")}
                  </div>
                )}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <label className="btn btn-sm">
                  {busy === k ? "Uploading…" : "Upload CSV"}
                  <input type="file" accept=".csv,.txt" hidden onChange={(e) => upload(k, e.target.files[0]) && (e.target.value = "")} />
                </label>{" "}
                {c?.[k] > 0 && (
                  <button type="button" className="link-btn small" onClick={() => clear(k)}>
                    Clear
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="check small">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Uploading replaces the existing list (untick to add to it)
      </label>
    </div>
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
