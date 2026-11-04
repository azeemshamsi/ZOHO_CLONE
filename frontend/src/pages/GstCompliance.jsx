import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { PageHeader, Spinner, Field, Modal, toast } from "../components/ui";
import { downloadJson } from "../components/GstPanel";

// Clear (GSP) connection: auth token, test / live, GSTIN. One per company.
function ClearSettings() {
  const { organization, setOrganization, user } = useAuth();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAdmin = !user?.permissions || user.permissions.settings === "full";
  useEffect(() => {
    api
      .get("/gst/gsp")
      .then((r) => {
        setD(r.data);
        const a = r.data.account;
        setF({ env: a.env || "sandbox", mode: a.mode === "token" && a.tokenSaved ? "token" : "gsp", host: a.host || "", gstin: a.gstin || "", token: "", clientId: a.clientId || "", clientSecret: "", username: a.username || "", password: "", publicKey: "" });
      })
      .catch(() => {});
  }, []);
  if (!d || !f) return null;
  const a = d.account;
  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.put("/gst/gsp", { ...f, active: true });
      setD({ ...d, account: data.account });
      setOrganization({ ...organization, gsp: data.organizationGsp });
      setF({ ...f, token: "" });
      toast(data.message);
      setOpen(false);
    } catch (e) {
      toast(errMsg(e), "error");
      api.get("/gst/gsp").then((r) => setD(r.data));
    }
    setBusy(false);
  };
  const off = async () => {
    try {
      const { data } = await api.put("/gst/gsp", { env: f.env, mode: f.mode, host: f.host, gstin: f.gstin, active: false });
      setD({ ...d, account: data.account });
      setOrganization({ ...organization, gsp: data.organizationGsp });
      toast("Clear disconnected — e-invoices and e-way bills go back to JSON upload");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="card form" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <strong>Clear (GSP)</strong>{" "}
          {a.active ? <span className="status status-paid">Connected · {a.env === "production" ? "Live" : "Sandbox"}</span> : <span className="status status-draft">Not connected</span>}
          <div className="muted small">
            {a.active
              ? `IRNs and e-way bills are generated and cancelled straight from OrdexaGo through Clear${a.gstin ? ` as GSTIN ${a.gstin}` : ""}${a.mode === "gsp" ? ` · API user ${a.username}` : ` · token …${a.tokenEnd}`}.`
              : a.lastError
              ? `Last check failed: ${a.lastError}`
              : "Connect your Clear account to generate IRNs and e-way bills in one click instead of uploading JSON."}
          </div>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" onClick={() => setOpen(!open)}>
              {open ? "Close" : a.tokenSaved || a.secretSaved ? "Edit connection" : "Connect Clear"}
            </button>
            {a.active && (
              <button className="btn btn-sm btn-ghost" onClick={off}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="row-3">
            <Field label="Environment">
              <select value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })}>
                <option value="sandbox">Sandbox (testing)</option>
                <option value="production">Live (production)</option>
              </select>
            </Field>
            <Field label="What Clear gave you">
              <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
                <option value="gsp">Client ID, secret, API username & password</option>
                <option value="token">An auth token</option>
              </select>
            </Field>
            <Field label="GSTIN" hint={`Blank = this company's GSTIN${organization?.gstin ? ` (${organization.gstin})` : ""}. In sandbox use Clear's test GSTIN.`}>
              <input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} />
            </Field>
          </div>
          {f.mode === "gsp" ? (
            <>
              <div className="row-2">
                <Field label="Client ID" required>
                  <input value={f.clientId} autoComplete="off" onChange={(e) => setF({ ...f, clientId: e.target.value.trim() })} />
                </Field>
                <Field label="Client secret" required={!a.secretSaved} hint={a.secretSaved ? "Saved. Leave blank to keep it." : ""}>
                  <input type="password" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value.trim() })} />
                </Field>
              </div>
              <div className="row-2">
                <Field label="API username" required>
                  <input value={f.username} autoComplete="off" onChange={(e) => setF({ ...f, username: e.target.value.trim() })} />
                </Field>
                <Field label="API password" required={!a.passwordSaved} hint={a.passwordSaved ? "Saved. Leave blank to keep it." : ""}>
                  <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
                </Field>
              </div>
              <Field label="Clear auth token (optional)" hint={a.tokenSaved ? `Saved (…${a.tokenEnd}). Leave blank to keep it.` : "Only if Clear also gave you an auth token (X-CT-Auth-Token)"}>
                <input type="password" autoComplete="new-password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value.trim() })} />
              </Field>
              <Field
                label="Clear's public key"
                required={!a.publicKeySaved}
                hint={
                  a.publicKeySaved
                    ? "Saved. Paste a new one only if you switch between sandbox and live."
                    : `Copy it from docs.cleartax.in → E-Invoicing GSP API → API Reference → "${f.env === "production" ? "Production" : "Sandbox"} Public Key" (or ask Clear). Paste everything including the BEGIN and END lines.`
                }
              >
                <textarea rows={4} style={{ fontFamily: "monospace", fontSize: 12 }} placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"} value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="Auth token" required={!a.tokenSaved} hint={a.tokenSaved ? `Saved (…${a.tokenEnd}). Leave blank to keep it.` : "From Clear for this workspace"}>
              <input type="password" autoComplete="new-password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value.trim() })} />
            </Field>
          )}
          <Field label="API address (optional)" hint={`Blank = Clear's default: ${d.hosts?.[f.env] || ""}. Only change it if Clear gave you a different address.`}>
            <input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} placeholder={d.hosts?.[f.env] || ""} />
          </Field>
          <div>
            <button className="btn btn-primary" disabled={busy || (f.mode === "token" ? !a.tokenSaved && !f.token : !f.clientId || !f.username || (!a.secretSaved && !f.clientSecret) || (!a.passwordSaved && !f.password) || (!a.publicKeySaved && !f.publicKey))} onClick={save}>
              {busy ? "Checking with Clear…" : "Save & Connect"}
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Each company has its own connection — switch company at the top to set up the other one. The API username and password are the ones created when Clear was added as your GSP on the e-invoice portal, so each GSTIN usually has its own. With these details, e-way bills are made for invoices that have an IRN; B2C e-way bills need Clear's e-way bill API (use Download JSON for those).
          </p>
        </div>
      )}
    </div>
  );
}

const docUrl = (r) => (r.kind === "creditNote" ? `/credit-notes/${r.id}` : `/invoices/${r.id}`);

export function GstCompliance({ tab: initial = "einvoice" }) {
  const { organization, setOrganization } = useAuth();
  const [tab, setTab] = useState(initial);
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const einv = organization?.einvoicing || {};
  const eway = organization?.ewayBills || {};
  const on = tab === "einvoice" ? einv.enabled : eway.enabled;
  const load = () => {
    setRows(null);
    setPicked(new Set());
    if (!on) return setRows([]);
    api.get(tab === "einvoice" ? "/gst/einvoices" : "/gst/eway-bills", { params: { status } }).then((r) => setRows(r.data));
  };
  useEffect(() => {
    setTab(initial);
  }, [initial]);
  useEffect(load, [tab, status, on]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (body) => {
    try {
      const { data } = await api.put("/gst/settings", body);
      setOrganization(data);
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const clearOn = !!organization?.gsp?.active;
  // Through Clear, the e-way bill distance / vehicle can be left out (distance from PINs, Part B later).
  const apiOk = (r) => !r.errors?.length || (clearOn && tab === "eway" && r.errors.every((x) => /distance|vehicle number, or a transporter/i.test(x)));
  const ok = (rows || []).filter(apiOk);
  const [results, setResults] = useState(null);
  const [generating, setGenerating] = useState(false);
  const bulkClear = async () => {
    setGenerating(true);
    try {
      const chosen = rows.filter((r) => picked.has(String(r.id)));
      const { data } =
        tab === "einvoice"
          ? await api.post("/gst/einvoice/bulk-generate", { docs: chosen.map((r) => ({ kind: r.kind, id: r.id })) })
          : await api.post("/gst/eway/bulk-generate", { ids: chosen.map((r) => r.id) });
      setResults(data.results.map((x) => ({ ...x, number: x.number || chosen.find((c) => String(c.id) === String(x.id))?.number })));
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setGenerating(false);
  };
  const bulk = async () => {
    try {
      const chosen = rows.filter((r) => picked.has(String(r.id)));
      if (tab === "einvoice") {
        const { data } = await api.post("/gst/einvoice/bulk-json", { docs: chosen.map((r) => ({ kind: r.kind, id: r.id })) });
        if (data.json.length) downloadJson(data.json, `einvoices-${isoDate()}.json`);
        toast(`${data.json.length} e-invoice(s) in the file${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}`);
      } else {
        const { data } = await api.post("/gst/eway/bulk-json", { ids: chosen.map((r) => r.id) });
        if (data.json.billLists.length) downloadJson(data.json, `ewaybills-${isoDate()}.json`);
        toast(`${data.json.billLists.length} e-way bill(s) in the file${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}`);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <PageHeader title={tab === "einvoice" ? "e-Invoices" : "e-Way Bills"} subtitle={tab === "einvoice" ? "IRN for B2B, SEZ and export invoices and credit notes" : "For goods worth ₹50,000 or more per consignment"}>
        <div className="seg">
          <Link className={tab === "einvoice" ? "on" : ""} to="/e-invoices">
            e-Invoices
          </Link>
          <Link className={tab === "eway" ? "on" : ""} to="/e-way-bills">
            e-Way Bills
          </Link>
        </div>
      </PageHeader>
      <div className="card form">
        {tab === "einvoice" ? (
          <div className="inline-add" style={{ flexWrap: "wrap", gap: 14 }}>
            <label className="check">
              <input type="checkbox" checked={!!einv.enabled} onChange={(e) => save({ einvoicing: { enabled: e.target.checked, fromDate: einv.fromDate || null } })} /> e-Invoicing applies to my business (turnover above the notified limit, currently ₹5 crore)
            </label>
            {einv.enabled && (
              <label className="check">
                From
                <input type="date" style={{ width: 160 }} value={einv.fromDate ? isoDate(einv.fromDate) : ""} onChange={(e) => save({ einvoicing: { enabled: true, fromDate: e.target.value || null } })} />
              </label>
            )}
          </div>
        ) : (
          <div className="inline-add" style={{ flexWrap: "wrap", gap: 14 }}>
            <label className="check">
              <input type="checkbox" checked={!!eway.enabled} onChange={(e) => save({ ewayBills: { enabled: e.target.checked, threshold: eway.threshold ?? 50000 } })} /> Track e-way bills on invoices for goods
            </label>
            {eway.enabled && (
              <label className="check">
                Required from ₹
                <input type="number" style={{ width: 120 }} value={eway.threshold ?? 50000} onChange={(e) => save({ ewayBills: { enabled: true, threshold: Number(e.target.value) || 0 } })} />
              </label>
            )}
          </div>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          {tab === "einvoice"
            ? "How it works: select invoices → Download JSON → on einvoice1.gst.gov.in use e-Invoice → Bulk Upload → it returns the IRN, Ack No and signed QR → open each invoice → Record IRN (or upload the response file). The QR code then prints on the invoice and PDF."
            : "How it works: add transport details on the invoice → select invoices → Download JSON → on ewaybillgst.gov.in use e-Waybill → Generate Bulk → open the invoice → Record EWB No. The e-way bill number then prints on the invoice and PDF."}
        </p>
      </div>
      <ClearSettings />
      {results && (
        <Modal open title={`Clear: ${results.filter((x) => !x.error).length} done, ${results.filter((x) => x.error).length} failed`} onClose={() => setResults(null)} footer={<button className="btn btn-primary" onClick={() => setResults(null)}>OK</button>}>
          <table className="table compact">
            <tbody>
              {results.map((x) => (
                <tr key={String(x.id)}>
                  <td>{x.number}</td>
                  <td className={x.error ? "text-danger small" : "small"}>{x.error || (x.irn ? `IRN ${x.irn.slice(0, 16)}… · Ack ${x.ackNo || ""}` : `EWB ${x.ewbNo}`) + (x.already ? " (already had one)" : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {on && (
        <div className="card flush">
          <div className="pad-row" style={{ padding: "10px 16px" }}>
            <div className="seg">
              {[
                ["pending", "Pending"],
                ["generated", "Generated"],
                ["cancelled", "Cancelled"],
              ].map(([k, l]) => (
                <button key={k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>
                  {l}
                </button>
              ))}
            </div>
            {status === "pending" && (
              <div style={{ display: "flex", gap: 6 }}>
                {clearOn && (
                  <button className="btn btn-primary btn-sm" disabled={!picked.size || generating} onClick={bulkClear}>
                    {generating ? "Generating…" : `Generate via Clear (${picked.size})`}
                  </button>
                )}
                <button className={`btn btn-sm ${clearOn ? "" : "btn-primary"}`} disabled={!picked.size} onClick={bulk}>
                  Download JSON ({picked.size})
                </button>
              </div>
            )}
          </div>
          {!rows ? (
            <Spinner />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {status === "pending" && (
                    <th>
                      <input type="checkbox" checked={ok.length > 0 && picked.size === ok.length} onChange={(e) => setPicked(new Set(e.target.checked ? ok.map((r) => String(r.id)) : []))} />
                    </th>
                  )}
                  <th>Date</th>
                  <th>Document</th>
                  <th>Customer</th>
                  <th className="num">Value</th>
                  <th>{status === "pending" ? "Ready?" : tab === "einvoice" ? "IRN / Ack" : "EWB No"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    {status === "pending" && (
                      <td>
                        <input
                          type="checkbox"
                          disabled={!apiOk(r)}
                          checked={picked.has(String(r.id))}
                          onChange={() => {
                            const n = new Set(picked);
                            n.has(String(r.id)) ? n.delete(String(r.id)) : n.add(String(r.id));
                            setPicked(n);
                          }}
                        />
                      </td>
                    )}
                    <td className="nowrap">{date(r.date)}</td>
                    <td>
                      <Link to={docUrl(r)}>
                        {r.kind === "creditNote" ? "Credit Note " : ""}
                        {r.number}
                      </Link>
                    </td>
                    <td>{r.customerName}</td>
                    <td className="num">{tab === "einvoice" ? money(r.total, r.currency) : money(r.value)}</td>
                    <td className="small">
                      {status === "pending" ? (
                        r.errors?.length && !apiOk(r) ? (
                          <span className="text-danger" title={r.errors.join("\n")}>
                            {r.errors.length} problem{r.errors.length > 1 ? "s" : ""}: {r.errors[0]}
                          </span>
                        ) : (
                          <span className="text-good">Ready{tab === "eway" && !r.required ? " (optional)" : ""}</span>
                        )
                      ) : tab === "einvoice" ? (
                        <span className="mono">
                          {r.einvoice.irn?.slice(0, 16)}… · {r.einvoice.ackNo}
                        </span>
                      ) : (
                        <>
                          {r.eway.ewbNo} {r.eway.validUpto && `· valid till ${date(r.eway.validUpto)}`}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="muted center">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
