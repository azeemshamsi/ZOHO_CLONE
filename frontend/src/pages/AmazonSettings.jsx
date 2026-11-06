import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Field, toast } from "../components/ui";
import { useAuth } from "../lib/auth";

// Store → Amazon: connect the Amazon seller account (Selling Partner API) so self-ship and Easy Ship orders
// come into Store → Orders, tracking goes back to Amazon, and orders are invoiced when shipped.

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function Guide() {
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        How to get your Amazon API keys (one time, about 15 minutes)
      </h4>
      <ol className="small" style={{ lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
        <li>
          Sign in to <strong>Seller Central (sellercentral.amazon.in)</strong> as the <em>primary account user</em>. Open <strong>Apps and Services → Develop Apps</strong>. The first time, Amazon asks you to register as a developer: choose <em>Private developer — I build apps for my own company</em>, fill in your contact details and tick these roles:
          <div style={{ margin: "4px 0 4px 10px" }}>
            <strong>Inventory and Order Tracking</strong> (orders, tracking), <strong>Amazon Fulfillment</strong> (Easy Ship pickups and labels), <strong>Selling Partner Insights</strong>, and the restricted role <strong>Direct-to-Consumer Shipping</strong> (buyer name, phone and address — needed to book your own couriers).
          </div>
          For the restricted role Amazon asks how you protect customer data: OrdexaGo stores addresses only to ship the order, on your own encrypted server, with role-based staff logins. Approval takes a few days; orders still come in meanwhile, just without addresses.
        </li>
        <li>
          Once approved, in <strong>Develop Apps</strong> click <strong>Add new app client</strong>: name it "OrdexaGo", API type <strong>SP API</strong>, tick the same roles, and save.
        </li>
        <li>
          On the app's row click <strong>View</strong> under <em>LWA credentials</em> and copy the <strong>Client identifier</strong> (amzn1.application-oa2-client…) and <strong>Client secret</strong>.
        </li>
        <li>
          Click the arrow next to <strong>Edit App</strong> → <strong>Authorize</strong> → <strong>Authorize app</strong>. Copy the <strong>Refresh token</strong> (starts with Atzr|). It doesn't expire unless you revoke it.
        </li>
        <li>
          Your <strong>Seller ID (Merchant Token)</strong> is under <strong>Settings → Account Info → Your Merchant Token</strong> (needed for Easy Ship labels).
        </li>
        <li>Paste all four below and click Save &amp; Connect. OrdexaGo checks them with Amazon straight away.</li>
      </ol>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Treat the client secret and refresh token like a password. If they were ever shared, rotate the secret in Develop Apps and authorise again.
      </p>
    </div>
  );
}

export default function AmazonSettings() {
  const { organization } = useAuth();
  const [a, setA] = useState(undefined);
  const [f, setF] = useState(null);
  const [ledgers, setLedgers] = useState([]);
  const [busy, setBusy] = useState(false);
  const poll = useRef();
  const fill = (x) => {
    setA(x);
    setF({ name: x?.name || "Amazon.in", sellerId: x?.sellerId || "", clientId: x?.clientId || "", clientSecret: "", refreshToken: "", syncFrom: day(x?.syncFrom) || day(Date.now() - 7 * 86400000), autoSync: x?.autoSync !== false, invoiceBy: x?.invoiceBy || "ordexago", invoiceStatus: x?.invoiceStatus || "sent", ledger: x?.ledger || "", shippingSac: x?.shippingSac || "996812" });
  };
  const load = () => api.get("/amazon-orders/account").then((r) => (fill(r.data), r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    api
      .get("/accounts")
      .then((r) => setLedgers(r.data.filter((x) => x.ledgerKind === "sales" || (x.group === "Income" && x.active !== false))))
      .catch(() => {});
    return () => clearTimeout(poll.current);
  }, []);
  const watch = () => {
    poll.current = setTimeout(async () => {
      const x = await load();
      if (x?.sync?.running) watch();
      else if (x?.sync?.error) toast(`Amazon sync failed: ${x.sync.error}`, "error");
      else if (x) toast(`Amazon: ${x.sync.created} new, ${x.sync.updated} updated${x.sync.invoiced ? `, ${x.sync.invoiced} invoiced` : ""}`);
    }, 1500);
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.put("/amazon-orders/account", { ...f, syncFrom: f.syncFrom || null });
      fill(data);
      toast(data.connected ? "Amazon connected" : "Saved");
      if (data.sync?.running || (data.connected && !a?.connected)) watch();
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  const sync = async (full) => {
    try {
      await api.post("/amazon-orders/sync", { full });
      setA({ ...a, sync: { ...(a.sync || {}), running: true } });
      watch();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  if (a === undefined || !f) return <Spinner />;
  const s = a?.sync || {};
  return (
    <>
      <PageHeader title="Amazon" subtitle={`Self-ship and Easy Ship orders of ${organization?.name || "this company"} in Store → Orders`} back="/shopify-orders">
        {a?.connected && (
          <>
            <button className="btn" disabled={s.running} onClick={() => sync(true)} title="Fetch every order from the 'bring in orders from' date again">
              Full re-sync
            </button>
            <button className="btn btn-primary" disabled={s.running} onClick={() => sync(false)}>
              {s.running ? `Syncing… ${s.fetched || 0}` : "Sync Orders"}
            </button>
          </>
        )}
      </PageHeader>
      {!a?.connected && <Guide />}
      {a?.connected && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div>
            <span className="pill pill-green">Connected</span> {a.lastSyncAt ? `Last synced ${new Date(a.lastSyncAt).toLocaleString("en-IN")}` : "Not synced yet"}
            {a.autoSync ? " · syncs every 15 min" : ""} · <Link to="/shopify-orders?tab=new">See orders</Link>
          </div>
          {!s.running && s.finishedAt && !s.error && (
            <div className="muted small">
              Last run: {s.fetched} orders read, {s.created} new, {s.updated} updated{s.invoiced ? `, ${s.invoiced} invoiced` : ""}
            </div>
          )}
          {s.error && <div className="text-red small">Last sync failed: {s.error}</div>}
          {a.pii && !a.pii.ok && a.pii.checkedAt && (
            <div className="alert alert-warn small" style={{ marginTop: 8 }}>
              Amazon isn't giving buyer names, phones and addresses yet, so self-ship orders can't be booked with your couriers. Add the restricted <strong>Direct-to-Consumer Shipping</strong> role to the app in Seller Central (Develop Apps), then authorise it again and paste the new refresh token here. Easy Ship orders work without it.
            </div>
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
            <Field label="LWA client ID" required hint="Develop Apps → your app → LWA credentials">
              <input value={f.clientId} onChange={set("clientId")} autoComplete="off" placeholder="amzn1.application-oa2-client…" />
            </Field>
            <Field label="LWA client secret" required={!a?.hasSecret} hint={a?.hasSecret ? "Saved. Leave blank to keep it." : ""}>
              <input type="password" value={f.clientSecret} onChange={set("clientSecret")} autoComplete="new-password" />
            </Field>
          </div>
          <div className="row-2">
            <Field label="Refresh token" required={!a?.hasRefreshToken} hint={a?.hasRefreshToken ? "Saved. Leave blank to keep it." : "From Authorize app (starts with Atzr|)"}>
              <input type="password" value={f.refreshToken} onChange={set("refreshToken")} autoComplete="new-password" />
            </Field>
            <Field label="Seller ID (Merchant Token)" hint="Settings → Account Info. Needed for Easy Ship labels.">
              <input value={f.sellerId} onChange={set("sellerId")} autoComplete="off" />
            </Field>
          </div>
          <div className="row-2">
            <Field label="Bring in orders from" hint="Self-ship (MFN) and Easy Ship orders placed from this date. FBA orders are not brought in.">
              <input type="date" value={f.syncFrom} onChange={set("syncFrom")} />
            </Field>
            <label className="check" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input type="checkbox" checked={f.autoSync} onChange={set("autoSync")} /> Sync new orders every 15 minutes
            </label>
          </div>
        </div>

        <h4 className="section-title">Invoices</h4>
        <div className="form-grid">
          <Field label="Who issues the invoice to the buyer">
            <select value={f.invoiceBy} onChange={set("invoiceBy")}>
              <option value="ordexago">OrdexaGo — invoice each order when it ships</option>
              <option value="amazon">Amazon (Amazon tax invoicing) — bring them in with the monthly MTR import</option>
            </select>
          </Field>
          {f.invoiceBy === "ordexago" ? (
            <div className="alert alert-info small">
              Orders placed from {a?.invoiceFrom ? new Date(a.invoiceFrom).toLocaleDateString("en-IN") : "today"} are invoiced in this company when you book the courier or schedule the Easy Ship pickup (or when Amazon reports them shipped). Consumers go to customer "Amazon B2C", Amazon Business buyers to their GSTIN. The monthly MTR import (Sales → Amazon Sales) then skips these orders and only tags them with Amazon's invoice number for the GSTR-1 check. If Amazon also issues invoices for you (Amazon tax invoicing is on in Seller Central), choose Amazon instead so the sale isn't invoiced twice.
            </div>
          ) : (
            <div className="alert alert-info small">Orders are processed here but not invoiced; import Amazon's MTR every month under Sales → Amazon Sales.</div>
          )}
          {f.invoiceBy === "ordexago" && (
            <div className="row-2">
              <Field label="Sales ledger" hint="Blank uses (or creates) Amazon Sales">
                <select value={f.ledger} onChange={set("ledger")}>
                  <option value="">Amazon Sales</option>
                  {ledgers
                    .filter((l) => l.name !== "Amazon Sales")
                    .map((l) => (
                      <option key={l.code || l._id} value={l.code || l._id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Create invoices as">
                <select value={f.invoiceStatus} onChange={set("invoiceStatus")}>
                  <option value="sent">Final (posted)</option>
                  <option value="draft">Draft</option>
                </select>
              </Field>
            </div>
          )}
        </div>
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Checking with Amazon…" : "Save & Connect"}
          </button>
          {a && (
            <button type="button" className="btn btn-ghost" onClick={() => window.confirm("Disconnect Amazon? Orders already in OrdexaGo stay.") && api.delete("/amazon-orders/account").then(() => load())}>
              Disconnect
            </button>
          )}
        </div>
      </form>
      {a?.connected && (
        <div className="card small" style={{ marginTop: 18 }}>
          <h4 className="section-title" style={{ marginTop: 0 }}>
            How Amazon orders work in OrdexaGo
          </h4>
          <ul style={{ paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
            <li>
              <strong>Self-ship</strong> orders: book them like Shopify orders (Ship → courier). The AWB and courier are sent to Amazon at once, so the buyer can track it. If that fails the order shows <em>Confirm on Amazon</em>.
            </li>
            <li>
              <strong>Easy Ship</strong> orders: click <em>Easy Ship</em>, choose the package and a pickup slot. Amazon's courier collects it; print <em>Amazon label</em> from the order.
            </li>
            <li>Cancellations and orders you ship from Seller Central update here on the next sync. Pending (payment not confirmed) orders appear once Amazon releases them.</li>
            <li>Returns: mark the return as with Shopify orders; if OrdexaGo made the invoice, closing the return makes the credit note.</li>
          </ul>
        </div>
      )}
    </>
  );
}
