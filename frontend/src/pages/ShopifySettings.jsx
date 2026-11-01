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
  trackUsername: "Tracking username",
  trackPassword: "Tracking password",
  pickupLocation: "Pickup location name",
  courierId: "Courier ID (optional)",
  autoPickup: "Schedule pickup automatically",
  shippingMode: "Shipping mode",
  customerCode: "Customer code",
  originArea: "Origin area code",
  productCode: "Product code",
  vendorCode: "Vendor code (optional)",
  serviceType: "Service type",
  commodityId: "Commodity ID (optional)",
};
const OPTIONAL = ["courierId", "vendorCode", "commodityId", "trackUsername", "trackPassword", "productCode", "serviceType", "shippingMode", "autoPickup"];
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
        <Field label="How MGI connects">
          <select value={f.authType} onChange={set("authType")}>
            <option value="client">App from the Shopify Dev Dashboard (Client ID + secret)</option>
            <option value="token">Older custom app (Admin API access token shpat_…)</option>
          </select>
        </Field>
        {f.authType === "client" ? (
          <>
            <div className="alert alert-info small">
              In <strong>dev.shopify.com/dashboard</strong>: create an app → <em>Versions</em> → add scopes <code>read_orders, read_all_orders, read_products, read_customers, read_inventory</code> (and <code>write_merchant_managed_fulfillment_orders</code> to mark orders fulfilled from MGI) → Release → <em>Home → Install</em> on your store. Then copy the Client ID and secret from <em>Settings</em>. The app and the store must be in the same Shopify organization.
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
          <button type="button" className="btn btn-ghost" onClick={() => window.confirm("Disconnect Shopify? Orders already in MGI stay.") && api.delete("/shopify/store").then(() => api.get("/shopify/store").then((r) => onSaved(r.data)))}>
            Disconnect
          </button>
        )}
      </div>
    </form>
  );
}

function Invoicing({ store, onSaved }) {
  const inv = store.invoice || {};
  const [f, setF] = useState({ status: inv.status || "sent", dateFrom: inv.dateFrom || "order", recordPayment: !!inv.recordPayment, paymentAccount: inv.paymentAccount || "", shippingSac: inv.shippingSac || "996812", trackInventory: !!inv.trackInventory });
  const [pkg, setPkg] = useState({ weight: store.pkg?.weight || 0.5, length: store.pkg?.length || 20, breadth: store.pkg?.breadth || 15, height: store.pkg?.height || 10 });
  const [ful, setFul] = useState({ fulfillInShopify: !!store.fulfillInShopify, notifyCustomer: store.notifyCustomer !== false });
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    api.get("/banking/accounts").then((r) => setAccounts(r.data)).catch(() => {});
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
      <p className="muted small">Shopify prices include GST. MGI takes the GST out of each price using the item's rate, puts discounts on the lines, adds shipping as a line at the order's highest GST rate, and makes the invoice total match Shopify to the paisa.</p>
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
        When a Shopify product becomes an item, MGI finds its category from the product type, Shopify category, tags or title (rules are checked top to bottom). The category sets the GST rate; a Shopify HSN that's missing, invalid or from another category is replaced by the category's default HSN. Anything changed is flagged under <Link to="/shopify-orders">Review items</Link>. Items that already exist keep their HSN and rate.
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
          <Field label="Name in MGI">
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
        {c.fields.options.length > 0 && (
          <div className="row-2">
            {c.fields.options.map((k) =>
              k === "autoPickup" ? (
                <label key={k} className="check" style={{ alignSelf: "end" }}>
                  <input type="checkbox" checked={!!f.options[k]} onChange={(e) => setF({ ...f, options: { ...f.options, [k]: e.target.checked } })} /> {FIELD_LABEL[k]}
                </label>
              ) : k === "shippingMode" ? (
                <Field key={k} label={FIELD_LABEL[k]}>
                  <select value={f.options[k] || "Surface"} onChange={(e) => setF({ ...f, options: { ...f.options, [k]: e.target.value } })}>
                    <option>Surface</option>
                    <option>Express</option>
                  </select>
                </Field>
              ) : (
                <Field key={k} label={FIELD_LABEL[k] || k} required={!OPTIONAL.includes(k)}>
                  <input value={f.options[k] || ""} onChange={(e) => setF({ ...f, options: { ...f.options, [k]: e.target.value } })} />
                </Field>
              )
            )}
          </div>
        )}
        {f.carrier === "custom" ? (
          <Field label="Tracking link" hint="Use {awb} where the tracking number goes">
            <input value={f.trackingUrl} onChange={(e) => setF({ ...f, trackingUrl: e.target.value })} placeholder="https://courier.example/track?awb={awb}" />
          </Field>
        ) : (
          <>
            <div className="label-sm">Pickup / return address</div>
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
                <td className="muted small">{a.pickup?.pincode ? `Pickup ${a.pickup.city || ""} ${a.pickup.pincode}` : a.carrier === "custom" ? "Manual AWB" : "No pickup address"}</td>
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
    if (store && window.location.hash === "#couriers") setTimeout(() => document.getElementById("couriers")?.scrollIntoView({ behavior: "smooth" }), 200);
  }, [!!store]);
  if (!store) return <Spinner />;
  const saved = (d) => setStore({ ...store, ...d, carriers: store.carriers, rules: d.rules || store.rules });
  return (
    <>
      <PageHeader title="Shopify Settings" back="/shopify-orders" subtitle="Connect your store, set how orders become invoices, GST rules for new items, and couriers." />
      <Connection store={store} onSaved={saved} />
      <Invoicing store={store} onSaved={saved} />
      <Rules key={JSON.stringify(store.rules).length} store={store} onSaved={saved} />
      <Couriers carriers={store.carriers} />
    </>
  );
}
