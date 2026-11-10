import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Field, toast } from "../components/ui";
import { useAuth } from "../lib/auth";

// Store → Flipkart: connect the Flipkart seller account (Seller API, self-access app) so orders come into
// Store → Orders, and Flipkart's stock follows the Shopify stock of the same SKU.

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const CARRIERS = [
  ["shiprocket", "Shiprocket"],
  ["delhivery", "Delhivery"],
  ["bluedart", "Blue Dart"],
  ["dtdc", "DTDC"],
  ["shadowfax", "Shadowfax"],
  ["custom", "Other courier"],
];

function Guide() {
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        How to get your Flipkart API keys (one time, 5 minutes)
      </h4>
      <ol className="small" style={{ lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
        <li>
          Sign in to <strong>Flipkart Seller Hub (seller.flipkart.com)</strong> as the admin user.
        </li>
        <li>
          Open <strong>Manage Profile → Developer Access</strong> and click <strong>Create New Access</strong>.
        </li>
        <li>Application name "OrdexaGo", any short description, then <strong>Submit</strong>.</li>
        <li>
          Copy the <strong>Application ID</strong> and <strong>Application Secret</strong> it shows, paste them below and click Save &amp; Connect.
        </li>
      </ol>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Keep the secret in your password manager and don't share it with anyone else — Flipkart may block a seller account whose keys are given to third parties.
      </p>
    </div>
  );
}

export default function FlipkartSettings() {
  const { organization } = useAuth();
  const [a, setA] = useState(undefined);
  const [f, setF] = useState(null);
  const [vendors, setVendors] = useState(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef();
  const fill = (x) => {
    setA(x);
    setF({
      name: x?.name || "Flipkart",
      appId: x?.appId || "",
      appSecret: "",
      locationId: x?.locationId || "",
      syncFrom: day(x?.syncFrom) || day(Date.now() - 7 * 86400000),
      autoSync: x?.autoSync !== false,
      stockSync: x?.stockSync !== false,
      stockBuffer: x?.stockBuffer ?? 0,
      reduceShopify: x?.reduceShopify !== false,
      selfShipPartners: x?.selfShipPartners || {},
    });
  };
  const load = () => api.get("/flipkart-orders/account").then((r) => (fill(r.data), r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    return () => clearTimeout(poll.current);
  }, []);
  useEffect(() => {
    if (a?.connected && vendors === null)
      api
        .get("/flipkart-orders/self-ship-vendors")
        .then((r) => setVendors(r.data))
        .catch(() => setVendors([]));
  }, [a?.connected]);
  const watch = (what) => {
    poll.current = setTimeout(async () => {
      const x = await load();
      const s = what === "stock" ? x?.stock : x?.sync;
      if (s?.running) watch(what);
      else if (s?.error) toast(`Flipkart ${what === "stock" ? "stock" : "sync"} failed: ${s.error}`, "error");
      else if (x && what === "stock") toast(`Flipkart stock: ${s.updated} SKUs updated${s.failed ? `, ${s.failed} failed` : ""}`);
      else if (x) toast(`Flipkart: ${s.created} new, ${s.updated} updated`);
    }, 2000);
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setPartner = (carrier, code) => {
    const v = (vendors || []).find((x) => x.code === code);
    setF({ ...f, selfShipPartners: { ...f.selfShipPartners, [carrier]: { code, name: v?.name || f.selfShipPartners[carrier]?.name || "" } } });
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.put("/flipkart-orders/account", { ...f, syncFrom: f.syncFrom || null, stockBuffer: Number(f.stockBuffer) || 0 });
      const first = data.connected && !a?.connected;
      fill(data);
      toast(data.connected ? "Flipkart connected" : "Saved");
      if (first) watch("sync");
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const run = async (what, body) => {
    try {
      await api.post(what === "stock" ? "/flipkart-orders/stock-sync" : "/flipkart-orders/sync", body);
      setA({ ...a, [what === "stock" ? "stock" : "sync"]: { ...((what === "stock" ? a.stock : a.sync) || {}), running: true } });
      watch(what);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  if (a === undefined || !f) return <Spinner />;
  const s = a?.sync || {};
  const st = a?.stock || {};
  return (
    <>
      <PageHeader title="Flipkart" subtitle={`Flipkart orders and stock of ${organization?.name || "this company"}`}>
        {a?.connected && (
          <button className="btn btn-primary" disabled={s.running} onClick={() => run("sync", {})}>
            {s.running ? `Syncing… ${s.fetched || 0}` : "Sync Orders"}
          </button>
        )}
      </PageHeader>
      {!a?.connected && <Guide />}
      {a?.connected && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div>
            <span className="pill pill-green">Connected</span> {a.lastSyncAt ? `Orders synced ${new Date(a.lastSyncAt).toLocaleString("en-IN")}` : "Orders not synced yet"}
            {a.autoSync ? " · every 15 min" : ""} · <Link to="/shopify-orders?tab=new">See orders</Link>
          </div>
          {!s.running && s.finishedAt && !s.error && <div className="muted small">Last run: {s.fetched} shipments read, {s.created} new, {s.updated} updated</div>}
          {s.error && <div className="text-red small">Last order sync failed: {s.error}</div>}
          <div style={{ marginTop: 8 }}>
            Stock: {st.finishedAt ? `last sent ${new Date(st.finishedAt).toLocaleString("en-IN")} · ${st.listings || 0} SKUs on Flipkart, ${st.updated || 0} updated${st.failed ? `, ${st.failed} failed` : ""}` : "not sent yet"}
            {a.stockSync ? " · every 30 min" : " · off"}{" "}
            <button className="btn btn-sm" disabled={st.running} onClick={() => run("stock", {})}>
              {st.running ? "Sending…" : "Send stock now"}
            </button>{" "}
            <button className="btn btn-sm btn-ghost" disabled={st.running} onClick={() => run("stock", { relist: true })} title="Look up every SKU on Flipkart again and send all quantities">
              Re-check all SKUs
            </button>
          </div>
          {st.error && <div className="text-red small">Stock sync failed: {st.error}</div>}
          {st.errors?.length > 0 && (
            <details className="small">
              <summary>{st.errors.length} SKU problem(s)</summary>
              <ul>
                {st.errors.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <form className="card form" onSubmit={save}>
        <h4 className="section-title" style={{ marginTop: 0 }}>
          Connection
          <span className={`pill ${a?.connected ? "pill-green" : ""}`}>{a?.connected ? "Connected" : "Not connected"}</span>
        </h4>
        <div className="form-grid">
          <div className="row-2">
            <Field label="Application ID">
              <input value={f.appId} onChange={set("appId")} autoComplete="off" />
            </Field>
            <Field label="Application Secret" hint={a?.hasSecret ? "Saved — leave blank to keep it" : ""}>
              <input type="password" value={f.appSecret} onChange={set("appSecret")} autoComplete="new-password" placeholder={a?.hasSecret ? "••••••••" : ""} />
            </Field>
          </div>
          <div className="row-2">
            <Field label="Bring in orders from" hint="Open orders always come in; shipped and cancelled ones from this date.">
              <input type="date" value={f.syncFrom} onChange={set("syncFrom")} />
            </Field>
            <Field label="Flipkart location ID" hint="Filled in from your orders. Change only if Flipkart support gives you another.">
              <input value={f.locationId} onChange={set("locationId")} placeholder="LOC…" />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.autoSync} onChange={set("autoSync")} /> Sync orders every 15 minutes
          </label>
        </div>

        <h4 className="section-title">Stock (follows Shopify)</h4>
        <p className="small muted">Each SKU listed on Flipkart gets the Shopify available quantity of the same SKU. SKUs not on Flipkart are skipped.</p>
        <div className="form-grid">
          <label className="check">
            <input type="checkbox" checked={f.stockSync} onChange={set("stockSync")} /> Send Shopify stock to Flipkart every 30 minutes
          </label>
          <div className="row-2">
            <Field label="Keep back (units per SKU)" hint="Flipkart shows Shopify stock minus this, so the last pieces stay for your website.">
              <input type="number" min="0" value={f.stockBuffer} onChange={set("stockBuffer")} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.reduceShopify} onChange={set("reduceShopify")} /> Take new Flipkart orders off the Shopify stock (and put cancelled ones back)
          </label>
        </div>

        <h4 className="section-title">Self-ship couriers</h4>
        <p className="small muted">
          When Flipkart asks you to self-ship, book your own courier from the order. OrdexaGo then tells Flipkart the courier and AWB, and the delivery. Choose the Flipkart name of each courier you use:
        </p>
        <div className="form-grid">
          {CARRIERS.map(([k, label]) => (
            <div className="row-2" key={k}>
              <Field label={label}>
                {vendors?.length ? (
                  <select value={f.selfShipPartners[k]?.code || ""} onChange={(e) => setPartner(k, e.target.value)}>
                    <option value="">— not used —</option>
                    {vendors.map((v) => (
                      <option key={v.code} value={v.code}>
                        {v.name} ({v.code})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={f.selfShipPartners[k]?.code || ""} onChange={(e) => setPartner(k, e.target.value)} placeholder={a?.connected ? "Flipkart courier code" : "Connect first"} />
                )}
              </Field>
            </div>
          ))}
        </div>

        <h4 className="section-title">Books</h4>
        <p className="small muted" style={{ marginTop: 0 }}>
          Flipkart orders aren't invoiced one by one here: Flipkart's sales go into the books with the monthly import in Sales → Flipkart Sales.
        </p>

        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : a?.connected ? "Save" : "Save & Connect"}
          </button>
          {a && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                if (!window.confirm("Disconnect Flipkart? Orders already in OrdexaGo stay.")) return;
                await api.delete("/flipkart-orders/account");
                load();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </form>
    </>
  );
}
