import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, Modal, Field, Confirm, toast, useDebounced } from "../components/ui";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import { STATES } from "../lib/constants";

const CH_LABEL = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram DMs", fb_comment: "Facebook comments", ig_comment: "Instagram comments", email: "Email" };
const DM = ["whatsapp", "messenger", "instagram"];
const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast("Copied"), () => toast("Couldn't copy", "error"));
const when = (d) => (d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className="switch-row">
      <span className="toggle">
        <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {label}
    </label>
  );
}

function Chips({ options, value = [], onChange }) {
  return (
    <div className="chip-checks">
      {options.map(([k, l]) => (
        <label key={k} className={`chip-check ${value.includes(k) ? "on" : ""}`}>
          <input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
          {l}
        </label>
      ))}
    </div>
  );
}

function Results({ results }) {
  if (!results?.length) return null;
  return (
    <ul className="test-results">
      {results.map((r, i) => (
        <li key={i} className={r.ok ? "text-good" : "text-danger"}>
          {r.ok ? "✓" : "✗"} <strong>{r.name}</strong>: <span className="muted-ink">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Guide({ title, children, open: initial = false }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="guide">
      <button className="guide-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="guide-body">{children}</div>}
    </div>
  );
}

/* ====================================================================================================
 * Integrations
 * ================================================================================================== */
export function Integrations() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [m, setM] = useState({});
  const [g, setG] = useState({});
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState(null);
  const [subResults, setSubResults] = useState(null);
  const [confirm, setConfirm] = useState("");
  const writable = can(user, "marketing", "full");

  const apply = (x) => {
    setD(x);
    setM({ appId: x.meta.appId, wabaId: x.meta.wabaId, phoneNumberId: x.meta.phoneNumberId, pageId: x.meta.pageId, igId: x.meta.igId, whatsapp: x.meta.whatsapp, messenger: x.meta.messenger, instagram: x.meta.instagram, fbComments: x.meta.fbComments, igComments: x.meta.igComments, appSecret: "", token: "" });
    setG({ clientId: x.google.clientId || "", clientSecret: "", enabled: x.google.enabled !== false });
  };
  const load = () => api.get("/integrations").then((r) => apply(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, []);
  useEffect(() => {
    const st = params.get("google");
    if (st === "connected") toast("Gmail connected — new emails arrive in the Inbox within 2 minutes");
    if (st === "error") toast(`Gmail wasn't connected: ${params.get("reason") || "try again"}`, "error");
    if (st) setParams({});
  }, []);
  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };
  if (!d) return <Spinner />;
  const mm = d.meta;
  const set = (k) => (e) => setM({ ...m, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Integrations" subtitle="Connect WhatsApp, Facebook, Instagram and Gmail for the Inbox, WhatsApp order updates and campaigns. Nothing runs until it's connected." />
      <div className="card">
        <div className="card-head">
          <h3>Meta — WhatsApp, Messenger, Instagram, comments</h3>
          {mm.hasToken ? <span className="pill pill-green">Token saved</span> : <span className="pill">Not connected</span>}
        </div>
        <div className="alert alert-info">
          <div>
            <strong>Webhook callback URL:</strong> <code>{d.callbackUrl}</code> <button className="link-btn" onClick={() => copy(d.callbackUrl)}>Copy</button>
          </div>
          <div>
            <strong>Verify token:</strong> <code>{mm.verifyToken}</code> <button className="link-btn" onClick={() => copy(mm.verifyToken)}>Copy</button>
            {writable && (
              <>
                {" · "}
                <button className="link-btn" onClick={() => setConfirm("verify")}>Make a new one</button>
              </>
            )}
          </div>
          <div className="small">Paste both in your Meta app: WhatsApp → Configuration → Webhook, and App Dashboard → Webhooks for the Page and Instagram objects. Graph API {d.graphVersion}.</div>
        </div>
        <div className="form-grid int-grid" style={{ marginTop: 14 }}>
          <Field label="Meta App ID">
            <input value={m.appId || ""} onChange={set("appId")} placeholder="e.g. 1234567890123456" />
          </Field>
          <Field label="App Secret" hint={mm.hasAppSecret ? "Saved — leave empty to keep it" : "App Dashboard → App settings → Basic"}>
            <input type="password" autoComplete="new-password" value={m.appSecret} onChange={set("appSecret")} placeholder={mm.hasAppSecret ? "••••••••" : ""} />
          </Field>
          <Field label="System User access token" hint={mm.hasToken ? "Saved — leave empty to keep it" : "Business Settings → System users → Generate token (never expires)"} className="span-2">
            <input type="password" autoComplete="new-password" value={m.token} onChange={set("token")} placeholder={mm.hasToken ? "••••••••" : "EAAG…"} />
          </Field>
          <Field label="WhatsApp Business Account ID (WABA)">
            <input value={m.wabaId || ""} onChange={set("wabaId")} />
          </Field>
          <Field label="WhatsApp phone number ID" hint={mm.displayPhone ? `${mm.displayPhone} · ${mm.verifiedName} · quality ${mm.qualityRating || "?"}${mm.messagingLimit ? ` · ${mm.messagingLimit}` : ""}` : "WhatsApp Manager → Phone numbers (the ID, not the number)"}>
            <input value={m.phoneNumberId || ""} onChange={set("phoneNumberId")} />
          </Field>
          <Field label="Facebook Page ID" hint={mm.pageName || ""}>
            <input value={m.pageId || ""} onChange={set("pageId")} />
          </Field>
          <Field label="Instagram business account ID" hint={mm.igUsername ? `@${mm.igUsername}` : "Linked to the Page"}>
            <input value={m.igId || ""} onChange={set("igId")} />
          </Field>
        </div>
        <div className="label-sm" style={{ marginTop: 6 }}>Channels in the Inbox</div>
        <div className="toggle-grid">
          <Toggle checked={m.whatsapp} onChange={(v) => setM({ ...m, whatsapp: v })} label="WhatsApp" />
          <Toggle checked={m.messenger} onChange={(v) => setM({ ...m, messenger: v })} label="Messenger" />
          <Toggle checked={m.instagram} onChange={(v) => setM({ ...m, instagram: v })} label="Instagram DMs" />
          <Toggle checked={m.fbComments} onChange={(v) => setM({ ...m, fbComments: v })} label="Facebook post comments" />
          <Toggle checked={m.igComments} onChange={(v) => setM({ ...m, igComments: v })} label="Instagram comments" />
        </div>
        {writable && (
          <div className="row-actions">
            <button className="btn btn-primary" disabled={!!busy} onClick={() => run("save", () => api.put("/integrations/meta", m).then((r) => apply(r.data)), "Saved")}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button className="btn" disabled={!!busy || !mm.hasToken} onClick={() => run("test", () => api.post("/integrations/meta/test").then((r) => (setResults(r.data.results), apply(r.data.integration))))}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button className="btn" disabled={!!busy || !mm.hasToken} onClick={() => run("sub", () => api.post("/integrations/meta/subscribe").then((r) => setSubResults(r.data.results)))}>
              {busy === "sub" ? "Subscribing…" : "Subscribe webhooks"}
            </button>
            {mm.hasToken && <button className="btn btn-danger" onClick={() => setConfirm("meta")}>Disconnect</button>}
          </div>
        )}
        <Results results={results || mm.lastTest?.results} />
        {!results && mm.lastTest?.at && <p className="muted small">Last tested {when(mm.lastTest.at)}</p>}
        <Results results={subResults} />
        {mm.lastWebhookAt && <p className="muted small">Last webhook received {when(mm.lastWebhookAt)}</p>}
        <MetaGuide callbackUrl={d.callbackUrl} />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <h3>Gmail (Google Workspace)</h3>
          {d.google.connected ? <span className="pill pill-green">{d.google.email || "Connected"}</span> : <span className="pill">Not connected</span>}
        </div>
        {!d.google.envClient && (
          <div className="form-grid int-grid">
            <Field label="Google OAuth client ID">
              <input value={g.clientId} onChange={(e) => setG({ ...g, clientId: e.target.value })} placeholder="…apps.googleusercontent.com" />
            </Field>
            <Field label="Client secret" hint={d.google.hasClientSecret ? "Saved — leave empty to keep it" : ""}>
              <input type="password" autoComplete="new-password" value={g.clientSecret} onChange={(e) => setG({ ...g, clientSecret: e.target.value })} placeholder={d.google.hasClientSecret ? "••••••••" : "GOCSPX-…"} />
            </Field>
          </div>
        )}
        {d.google.envClient && <p className="muted small">The OAuth client is set on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>}
        <p className="small">
          Authorised redirect URI: <code>{d.google.redirectUri}</code> <button className="link-btn" onClick={() => copy(d.google.redirectUri)}>Copy</button>
        </p>
        {d.google.connected && (
          <p className="small muted">
            Connected {when(d.google.connectedAt)} · last checked {when(d.google.lastPollAt)}
            {d.google.error && <span className="text-danger"> · {d.google.error}</span>}
          </p>
        )}
        {d.google.connected && <Toggle checked={g.enabled} onChange={(v) => run("gsave", () => api.put("/integrations/google", { enabled: v }).then((r) => apply(r.data)), v ? "Gmail resumed" : "Gmail paused")} label="Fetch new emails every 2 minutes" />}
        {writable && (
          <div className="row-actions">
            {!d.google.envClient && (
              <button className="btn" disabled={!!busy} onClick={() => run("gsave", () => api.put("/integrations/google", { clientId: g.clientId, clientSecret: g.clientSecret }).then((r) => apply(r.data)), "Saved")}>
                Save
              </button>
            )}
            <button className="btn btn-primary" disabled={!!busy || (!d.google.envClient && !(g.clientId && (d.google.hasClientSecret || g.clientSecret)))} onClick={() => run("gauth", async () => {
              if (!d.google.envClient && g.clientSecret) await api.put("/integrations/google", { clientId: g.clientId, clientSecret: g.clientSecret });
              const r = await api.get("/integrations/google/auth-url");
              window.location.href = r.data.url;
            })}>
              {d.google.connected ? "Reconnect Gmail" : "Connect Gmail"}
            </button>
            {d.google.connected && <button className="btn" disabled={!!busy} onClick={() => run("poll", () => api.post("/integrations/google/poll"), "Checked for new emails")}>Check now</button>}
            {d.google.connected && <button className="btn btn-danger" onClick={() => setConfirm("google")}>Disconnect</button>}
          </div>
        )}
        <GoogleGuide redirect={d.google.redirectUri} />
      </div>
      <Confirm
        open={!!confirm}
        title={confirm === "verify" ? "Make a new verify token?" : `Disconnect ${confirm === "meta" ? "Meta" : "Gmail"}?`}
        text={confirm === "verify" ? "Paste the new token in the Meta app's webhook settings, or Meta can't verify the callback again." : "The stored tokens are deleted. Conversations stay in the Inbox."}
        confirmLabel={confirm === "verify" ? "Make new token" : "Disconnect"}
        onCancel={() => setConfirm("")}
        onConfirm={() => {
          const c = confirm;
          setConfirm("");
          run(c, () => (c === "verify" ? api.post("/integrations/meta/verify-token") : api.delete(`/integrations/${c}`)).then((r) => apply(r.data)), c === "verify" ? "New verify token made" : "Disconnected");
        }}
      />
    </>
  );
}

function MetaGuide({ callbackUrl }) {
  return (
    <Guide title="Step-by-step: set up the Meta app (WhatsApp, Messenger, Instagram)">
      <ol className="guide-steps">
        <li>
          <strong>Create the app.</strong> At developers.facebook.com → My Apps → Create app → use case “Other” → type <b>Business</b>, and pick your Business portfolio (the one that owns your WABA, Page and Instagram). Copy the <b>App ID</b> and <b>App Secret</b> (App settings → Basic) into the fields above.
        </li>
        <li>
          <strong>Add the products:</strong> WhatsApp, Messenger, and Instagram (“Instagram API with Facebook Login” / Messenger API for Instagram). For WhatsApp, link your existing WhatsApp Business Account. Copy the <b>WABA ID</b> and the <b>Phone number ID</b> from WhatsApp → API setup (or WhatsApp Manager).
        </li>
        <li>
          <strong>System user.</strong> Business Settings → Users → System users → Add (Admin). <b>Assign assets</b>: the app (full control), the WhatsApp account (full control), the Facebook Page (full control, incl. messages) and the Instagram account. Then <b>Generate new token</b> for the app, expiry <b>Never</b>, with these permissions: whatsapp_business_messaging, whatsapp_business_management, pages_messaging, pages_manage_metadata, pages_read_engagement, pages_manage_engagement, pages_show_list, instagram_basic, instagram_manage_messages, instagram_manage_comments, business_management. Paste it above.
        </li>
        <li>
          <strong>Page and Instagram IDs.</strong> Page ID: your Page → About → Page transparency (or Business Settings → Pages). Instagram business account ID: Business Settings → Instagram accounts (the account must be a Business/Creator account linked to the Page).
        </li>
        <li>
          <strong>Webhooks.</strong> WhatsApp → Configuration → Webhook: Callback URL <code>{callbackUrl}</code> and the verify token above; subscribe the field <b>messages</b>. App Dashboard → Webhooks → <b>Page</b>: same URL + token; tick <b>messages, messaging_postbacks, message_deliveries, message_reads, message_echoes, feed</b>. Webhooks → <b>Instagram</b>: tick <b>messages, messaging_postbacks, comments</b> (and live_comments if you go live). Then Save here, press <b>Test connection</b> and <b>Subscribe webhooks</b>.
        </li>
        <li>
          <strong>Instagram setting.</strong> In the Instagram app: Settings → Messages and story replies → Message controls → Connected tools → allow access to messages.
        </li>
        <li>
          <strong>Go live.</strong> Switch the app to <b>Live</b> mode. WhatsApp works right away for your own WABA. To reply to the <i>public</i> on Messenger and Instagram (people who aren't app testers), Meta requires <b>App Review</b> with <b>Advanced Access</b> for pages_messaging, instagram_manage_messages, instagram_manage_comments, pages_manage_engagement and pages_read_engagement, plus <b>Business verification</b> of your business portfolio. Until then only people with a role on the app get replies.
        </li>
        <li>
          <strong>Templates.</strong> Create message templates in WhatsApp Manager (Utility for order updates, Marketing for broadcasts), wait for approval, then press “Sync templates” on Marketing → Automations.
        </li>
      </ol>
    </Guide>
  );
}

function GoogleGuide({ redirect }) {
  return (
    <Guide title="Step-by-step: set up Gmail (Google Cloud OAuth client)">
      <ol className="guide-steps">
        <li>At console.cloud.google.com create a project (e.g. “OrdexaGo Inbox”) while signed in with your Google Workspace admin.</li>
        <li>APIs & Services → Library → enable the <b>Gmail API</b>.</li>
        <li>
          APIs & Services → OAuth consent screen (Google Auth Platform → Branding / Audience): user type <b>Internal</b> (only your Workspace users — no Google verification needed). App name OrdexaGo, support email help@ordexago.com. Data access / scopes: <code>gmail.modify</code> and <code>gmail.send</code>.
        </li>
        <li>
          Credentials (Clients) → Create OAuth client ID → <b>Web application</b>. Authorised redirect URI: <code>{redirect}</code>. Copy the <b>client ID</b> and <b>client secret</b> into the fields above (or into the server's .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
        </li>
        <li>Press <b>Connect Gmail</b> and sign in with the mailbox the Inbox should use (e.g. help@ordexago.com). OrdexaGo checks it every 2 minutes and replies from it, in the same thread.</li>
      </ol>
    </Guide>
  );
}

/* ====================================================================================================
 * Automations: WhatsApp order updates + templates
 * ================================================================================================== */
const EVENT_HELP = {
  order_placed: "When a new store order comes in (orders from the last 2 days only).",
  cod_confirmation: "New COD orders. Use a template with two quick-reply buttons (e.g. “Confirm” and “Cancel”). Answers show in the Inbox and on the order; Cancel only flags the order for your team.",
  shipped: "When the order ships — at booking or at the courier's pickup scan (below).",
  out_for_delivery: "When the courier marks it out for delivery.",
  delivered: "When it's delivered.",
  rto: "When the courier starts returning it to you (RTO).",
};

export function Automations() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [tpls, setTpls] = useState([]);
  const [busy, setBusy] = useState("");
  const [test, setTest] = useState(null);
  const writable = can(user, "marketing", "full");
  const load = () => Promise.all([api.get("/marketing/config"), api.get("/marketing/templates")]).then(([a, b]) => (setCfg(a.data), setTpls(b.data)));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!cfg) return <Spinner />;
  const approved = tpls.filter((t) => t.status === "APPROVED");
  const setEv = (e, patch) => setCfg({ ...cfg, orderUpdates: { ...cfg.orderUpdates, [e]: { ...cfg.orderUpdates[e], ...patch } } });
  const save = async () => {
    setBusy("save");
    try {
      const r = await api.put("/marketing/config", { orderUpdates: Object.fromEntries(Object.keys(cfg.events).map((e) => [e, { enabled: !!cfg.orderUpdates[e]?.enabled, template: cfg.orderUpdates[e]?.template || "", language: cfg.orderUpdates[e]?.language || "en", params: cfg.orderUpdates[e]?.params || [], headerParam: cfg.orderUpdates[e]?.headerParam || "", urlButtonParam: cfg.orderUpdates[e]?.urlButtonParam || "" }])), shippedOn: cfg.shippedOn });
      setCfg(r.data);
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  const sync = async () => {
    setBusy("sync");
    try {
      setTpls((await api.post("/marketing/templates/sync")).data);
      toast("Templates synced from WhatsApp");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  const varOpts = Object.entries(cfg.vars);
  return (
    <>
      <PageHeader title="Automations" subtitle="WhatsApp order updates: each event sends your approved template automatically — once per order, never to numbers that sent STOP.">
        {writable && <button className="btn" disabled={!!busy} onClick={sync}>{busy === "sync" ? "Syncing…" : "Sync templates"}</button>}
        {writable && <button className="btn btn-primary" disabled={!!busy} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>}
      </PageHeader>
      <div className="card">
        <Field label="Send “Shipped” when">
          <div className="radio-row">
            <label className="radio"><input type="radio" checked={cfg.shippedOn === "booked"} onChange={() => setCfg({ ...cfg, shippedOn: "booked" })} /> the courier is booked (AWB created)</label>
            <label className="radio"><input type="radio" checked={cfg.shippedOn === "picked"} onChange={() => setCfg({ ...cfg, shippedOn: "picked" })} /> the courier picks it up</label>
          </div>
        </Field>
      </div>
      {Object.entries(cfg.events).map(([e, label]) => {
        const ev = cfg.orderUpdates[e] || {};
        const t = approved.find((x) => x.name === ev.template && x.language === (ev.language || "en")) || approved.find((x) => x.name === ev.template);
        const n = t?.bodyParams ?? (ev.params || []).length;
        const hasUrl = (t?.buttons || []).some((b) => b.type === "URL" && /\{\{1\}\}/.test(b.url || ""));
        const quick = (t?.buttons || []).filter((b) => b.type === "QUICK_REPLY").length;
        return (
          <div key={e} className="card" style={{ marginTop: 14 }}>
            <div className="card-head">
              <Toggle checked={ev.enabled} onChange={(v) => setEv(e, { enabled: v })} label={<strong>{label}</strong>} />
              {writable && ev.template && <button className="btn btn-sm" onClick={() => setTest({ event: e, order: "", to: "" })}>Test</button>}
            </div>
            <p className="muted small">{EVENT_HELP[e]}</p>
            <div className="form-grid">
              <Field label="Template">
                <select
                  value={ev.template ? `${ev.template}|${ev.language || "en"}` : ""}
                  onChange={(x) => {
                    const [name, language] = x.target.value.split("|");
                    const tt = approved.find((y) => y.name === name && y.language === language);
                    setEv(e, { template: name || "", language: language || "en", params: Array.from({ length: tt?.bodyParams || 0 }, (_, i) => (ev.params || [])[i] || ""), headerParam: tt?.headerParams ? ev.headerParam || "" : "", urlButtonParam: "" });
                  }}
                >
                  <option value="">Choose an approved template</option>
                  {approved.map((x) => (
                    <option key={x._id} value={`${x.name}|${x.language}`}>
                      {x.name} ({x.language}, {x.category?.toLowerCase()})
                    </option>
                  ))}
                </select>
              </Field>
              {t && <div className="tpl-preview small">{t.components?.find((c) => c.type === "BODY")?.text}</div>}
            </div>
            {e === "cod_confirmation" && t && quick < 2 && <div className="alert alert-warn">This template has {quick} quick-reply button{quick === 1 ? "" : "s"} — add two (Confirm, Cancel) so buyers can answer.</div>}
            {n > 0 && (
              <div className="param-grid">
                {Array.from({ length: n }, (_, i) => (
                  <Field key={i} label={`{{${i + 1}}}`}>
                    <select value={(ev.params || [])[i] || ""} onChange={(x) => setEv(e, { params: Array.from({ length: n }, (_, j) => (j === i ? x.target.value : (ev.params || [])[j] || "")) })}>
                      <option value="">Choose…</option>
                      {varOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </Field>
                ))}
                {t?.headerParams > 0 && (
                  <Field label="Header {{1}}">
                    <select value={ev.headerParam || ""} onChange={(x) => setEv(e, { headerParam: x.target.value })}>
                      <option value="">Choose…</option>
                      {varOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </Field>
                )}
                {hasUrl && (
                  <Field label="Button link {{1}}">
                    <select value={ev.urlButtonParam || ""} onChange={(x) => setEv(e, { urlButtonParam: x.target.value })}>
                      <option value="">Choose…</option>
                      {varOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </Field>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="card flush" style={{ marginTop: 18 }}>
        <div className="card-title"><h3 className="card-title pad">WhatsApp templates</h3></div>
        <table className="table">
          <thead><tr><th>Name</th><th>Language</th><th>Category</th><th>Status</th><th>Variables</th><th>Buttons</th></tr></thead>
          <tbody>
            {!tpls.length && <tr><td colSpan={6} className="muted">No templates yet. Create them in WhatsApp Manager (Message templates), then press “Sync templates”.</td></tr>}
            {tpls.map((t) => (
              <tr key={t._id}>
                <td><strong>{t.name}</strong></td>
                <td>{t.language}</td>
                <td>{t.category}</td>
                <td><span className={`pill ${t.status === "APPROVED" ? "pill-green" : t.status === "REJECTED" ? "pill-red" : "pill-amber"}`}>{t.status}</span></td>
                <td>{t.bodyParams + (t.headerParams || 0)}</td>
                <td className="small">{(t.buttons || []).map((b) => b.text).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!test}
        title={`Test: ${cfg.events[test?.event] || ""}`}
        onClose={() => setTest(null)}
        footer={
          <>
            <button className="btn" onClick={() => setTest(null)}>Close</button>
            <button className="btn btn-primary" disabled={busy === "test"} onClick={async () => {
              setBusy("test");
              try {
                await save();
                const r = await api.post("/marketing/automations/test", test);
                toast(`Sent: ${r.data.preview.join(" · ")}`);
              } catch (e) {
                toast(errMsg(e), "error");
              }
              setBusy("");
            }}>
              {busy === "test" ? "Sending…" : "Send test"}
            </button>
          </>
        }
      >
        <p className="muted small">Sends this event's template with a real order's details to the number you enter (not to the buyer). Settings are saved first.</p>
        <Field label="Order number"><input value={test?.order || ""} onChange={(e) => setTest({ ...test, order: e.target.value })} placeholder="#201114" /></Field>
        <Field label="Send to WhatsApp number"><input value={test?.to || ""} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder="98765 43210" /></Field>
      </Modal>
    </>
  );
}

/* ====================================================================================================
 * Campaigns
 * ================================================================================================== */
const EMPTY_AUD = { source: "orders", lastDays: "", notSinceDays: "", states: [], cities: "", skus: "", products: "", payment: "", minOrders: "", maxOrders: "", minSpend: "", maxSpend: "", tags: "", consent: "subscribed" };
const toList = (s) => (Array.isArray(s) ? s : String(s || "").split(",").map((x) => x.trim()).filter(Boolean));
const num = (v) => (v === "" || v == null ? null : Number(v));
const audBody = (a) => ({ source: a.source, lastDays: num(a.lastDays), notSinceDays: num(a.notSinceDays), states: a.states || [], cities: toList(a.cities), skus: toList(a.skus), products: toList(a.products), payment: a.payment || "", minOrders: num(a.minOrders), maxOrders: num(a.maxOrders), minSpend: num(a.minSpend), maxSpend: num(a.maxSpend), tags: toList(a.tags), consent: a.consent || "subscribed" });
const audForm = (a = {}) => ({ ...EMPTY_AUD, ...a, cities: toList(a.cities).join(", "), skus: toList(a.skus).join(", "), products: toList(a.products).join(", "), tags: toList(a.tags).join(", "), lastDays: a.lastDays ?? "", notSinceDays: a.notSinceDays ?? "", minOrders: a.minOrders ?? "", maxOrders: a.maxOrders ?? "", minSpend: a.minSpend ?? "", maxSpend: a.maxSpend ?? "" });
const C_STATUS = { draft: "", scheduled: "pill-amber", running: "pill-amber", paused: "", done: "pill-green", cancelled: "pill-red", failed: "pill-red" };

function AudienceEditor({ channel, a, setA }) {
  const [p, setP] = useState(null);
  const body = useDebounced(JSON.stringify({ channel, audience: audBody(a) }), 500);
  useEffect(() => {
    setP(null);
    api.post("/marketing/audience/preview", JSON.parse(body)).then((r) => setP(r.data)).catch((e) => setP({ error: errMsg(e) }));
  }, [body]);
  const set = (k) => (e) => setA({ ...a, [k]: e.target.value });
  return (
    <div className="aud">
      <div className="form-grid">
        <Field label="People from">
          <select value={a.source} onChange={set("source")}>
            <option value="orders">Store orders (Shopify)</option>
            <option value="customers">Customers in OrdexaGo</option>
            <option value="both">Both</option>
          </select>
        </Field>
        <Field label="Consent" hint={channel === "whatsapp" ? "WhatsApp's rules: only message people who agreed to hear from you" : "Shopify's email-marketing consent"}>
          <select value={a.consent} onChange={set("consent")}>
            <option value="subscribed">Only people subscribed in Shopify</option>
            <option value="any">Everyone except unsubscribed / opted out</option>
          </select>
        </Field>
        <Field label="Ordered in the last … days"><input type="number" min="0" value={a.lastDays} onChange={set("lastDays")} /></Field>
        <Field label="Not ordered in the last … days" hint="Win back lapsed buyers"><input type="number" min="0" value={a.notSinceDays} onChange={set("notSinceDays")} /></Field>
        <Field label="Payment"><select value={a.payment} onChange={set("payment")}><option value="">Any</option><option value="cod">Has a COD order</option><option value="prepaid">Has a prepaid order</option></select></Field>
        <Field label="Cities" hint="Comma separated"><input value={a.cities} onChange={set("cities")} placeholder="Mumbai, Pune" /></Field>
        <Field label="Bought SKU" hint="Comma separated"><input value={a.skus} onChange={set("skus")} /></Field>
        <Field label="Bought a product named"><input value={a.products} onChange={set("products")} placeholder="table, stool" /></Field>
        <Field label="Orders (min – max)"><div className="inline-add"><input type="number" min="0" value={a.minOrders} onChange={set("minOrders")} /><input type="number" min="0" value={a.maxOrders} onChange={set("maxOrders")} /></div></Field>
        <Field label="Total spend ₹ (min – max)"><div className="inline-add"><input type="number" min="0" value={a.minSpend} onChange={set("minSpend")} /><input type="number" min="0" value={a.maxSpend} onChange={set("maxSpend")} /></div></Field>
        <Field label="Order tags" hint="Comma separated"><input value={a.tags} onChange={set("tags")} /></Field>
        <Field label="States">
          <select value="" onChange={(e) => e.target.value && setA({ ...a, states: [...new Set([...(a.states || []), e.target.value])] })}>
            <option value="">{a.states?.length ? "Add another state…" : "Any state — choose to limit"}</option>
            {STATES.filter(([code]) => !(a.states || []).includes(code)).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          {(a.states || []).length > 0 && (
            <div style={{ marginTop: 4 }}>
              {a.states.map((code) => (
                <span key={code} className="chip">
                  {STATES.find(([c]) => c === code)?.[1] || code} <button type="button" className="link-btn" onClick={() => setA({ ...a, states: a.states.filter((x) => x !== code) })}>×</button>
                </span>
              ))}
            </div>
          )}
        </Field>
      </div>
      <div className="aud-count">
        {!p ? (
          <span className="muted">Counting…</span>
        ) : p.error ? (
          <span className="text-danger">{p.error}</span>
        ) : (
          <>
            <strong className="big">{p.count.toLocaleString("en-IN")}</strong> people will get this
            <span className="muted small"> · {p.matchedBeforeConsent} match the filters; {p.excluded.consent} without consent, {p.excluded.optedOut} opted out{!p.consentRecords ? " · no Shopify consent synced yet (Auto-replies → Opt-outs → Sync consent)" : ""}</span>
            {p.sample?.length > 0 && <div className="small muted">e.g. {p.sample.map((s) => `${s.name || s.to} (${s.orders} orders)`).join(", ")}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function CampaignEditor({ initial, onClose, onSaved }) {
  const [c, setC] = useState(() => ({ name: "", channel: "whatsapp", whatsapp: { template: "", language: "en", params: [], headerParam: "", headerMediaUrl: "" }, email: { subject: "", body: "Hi {{name}},\n\n" }, ...initial, audience: audForm(initial?.audience) }));
  const [tpls, setTpls] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/marketing/templates").then((r) => setTpls(r.data.filter((t) => t.status === "APPROVED" && t.category === "MARKETING"))).catch(() => {});
  }, []);
  const t = tpls.find((x) => x.name === c.whatsapp?.template && x.language === c.whatsapp?.language);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: c.name, channel: c.channel, audience: audBody(c.audience), whatsapp: c.whatsapp, email: c.email };
      const r = c._id ? await api.put(`/marketing/campaigns/${c._id}`, body) : await api.post("/marketing/campaigns", body);
      toast("Saved");
      onSaved(r.data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal open wide title={c._id ? "Edit campaign" : "New campaign"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !c.name} onClick={save}>{busy ? "Saving…" : "Save draft"}</button></>}>
      <div className="form-grid">
        <Field label="Name" required><input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Diwali sale" /></Field>
        <Field label="Channel">
          <select value={c.channel} disabled={!!c._id} onChange={(e) => setC({ ...c, channel: e.target.value })}>
            <option value="whatsapp">WhatsApp (marketing template)</option>
            <option value="email">Email</option>
          </select>
        </Field>
      </div>
      <h4 className="sec-h">Who gets it</h4>
      <AudienceEditor channel={c.channel} a={c.audience} setA={(a) => setC({ ...c, audience: a })} />
      <h4 className="sec-h">Message</h4>
      {c.channel === "whatsapp" ? (
        <>
          <Field label="Template" hint="Only approved MARKETING templates can be broadcast">
            <select value={c.whatsapp.template ? `${c.whatsapp.template}|${c.whatsapp.language}` : ""} onChange={(e) => {
              const [name, language] = e.target.value.split("|");
              const tt = tpls.find((x) => x.name === name && x.language === language);
              setC({ ...c, whatsapp: { ...c.whatsapp, template: name || "", language: language || "en", params: Array.from({ length: tt?.bodyParams || 0 }, (_, i) => c.whatsapp.params?.[i] || (i === 0 ? "{{name}}" : "")) } });
            }}>
              <option value="">Choose…</option>
              {tpls.map((x) => <option key={x._id} value={`${x.name}|${x.language}`}>{x.name} ({x.language})</option>)}
            </select>
          </Field>
          {t && <div className="tpl-preview">{t.components?.find((x) => x.type === "BODY")?.text}</div>}
          {(c.whatsapp.params || []).map((v, i) => (
            <Field key={i} label={`{{${i + 1}}}`} hint="Text, or {{name}}, {{full_name}}, {{orders}}, {{spend}}, {{last_order}}, {{city}}, {{store_name}}">
              <input value={v} onChange={(e) => setC({ ...c, whatsapp: { ...c.whatsapp, params: c.whatsapp.params.map((x, j) => (j === i ? e.target.value : x)) } })} />
            </Field>
          ))}
          {t?.headerFormat === "IMAGE" && <Field label="Header image URL (https)"><input value={c.whatsapp.headerMediaUrl || ""} onChange={(e) => setC({ ...c, whatsapp: { ...c.whatsapp, headerMediaUrl: e.target.value } })} /></Field>}
          {t?.headerParams > 0 && <Field label="Header {{1}}"><input value={c.whatsapp.headerParam || ""} onChange={(e) => setC({ ...c, whatsapp: { ...c.whatsapp, headerParam: e.target.value } })} /></Field>}
          {!tpls.length && <p className="muted small">No approved MARKETING templates synced. Create one in WhatsApp Manager, then Sync templates on Automations.</p>}
        </>
      ) : (
        <>
          <Field label="Subject"><input value={c.email.subject} onChange={(e) => setC({ ...c, email: { ...c.email, subject: e.target.value } })} /></Field>
          <Field label="Message" hint="Plain text; {{name}} etc. work. Your company address and an unsubscribe link are added at the bottom.">
            <textarea rows={8} value={c.email.body} onChange={(e) => setC({ ...c, email: { ...c.email, body: e.target.value } })} />
          </Field>
        </>
      )}
    </Modal>
  );
}

function CampaignView({ id, onClose, onChanged }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [filter, setFilter] = useState("");
  const [to, setTo] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState("");
  const [edit, setEdit] = useState(false);
  const writable = can(user, "marketing", "full");
  const load = () => api.get(`/marketing/campaigns/${id}`, { params: { status: filter } }).then((r) => setD(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    const t = setInterval(() => {
      load().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [id, filter]);
  const act = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
  };
  if (!d) return <Modal open title="Campaign" onClose={onClose}><Spinner /></Modal>;
  const c = d.campaign;
  const t = c.totals || {};
  const draft = ["draft", "scheduled"].includes(c.status);
  return (
    <Modal open wide title={c.name} onClose={onClose}>
      <p>
        <span className={`pill ${C_STATUS[c.status]}`}>{c.status}</span> <span className="muted small">{c.channel === "whatsapp" ? `WhatsApp · ${c.whatsapp?.template}` : `Email · ${c.email?.subject}`} · by {c.createdByName} · {when(c.createdAt)}{c.scheduledAt ? ` · send ${when(c.scheduledAt)}` : ""}</span>
      </p>
      {c.error && <div className="alert alert-warn">{c.error}</div>}
      <div className="stats-row">
        {[["recipients", "People"], ["sent", "Sent"], ["delivered", "Delivered"], ["read", "Read"], ["replied", "Replied"], ["failed", "Failed"], ["skipped", "Skipped"]].map(([k, l]) => (
          <div key={k}><div className="muted small">{l}</div><div className="stat-value">{(t[k] || 0).toLocaleString("en-IN")}</div></div>
        ))}
      </div>
      {writable && (
        <div className="row-actions">
          {draft && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
          {draft && (
            <span className="inline-add">
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={c.channel === "whatsapp" ? "Test to WhatsApp number" : "Test to email"} />
              <button className="btn" disabled={!!busy || !to} onClick={() => act("test", () => api.post(`/marketing/campaigns/${id}/test`, { to }), "Test sent")}>{busy === "test" ? "Sending…" : "Send test"}</button>
            </span>
          )}
          {draft && (
            <span className="inline-add">
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} title="Schedule (leave empty to send now)" />
              <button className="btn btn-primary" disabled={!!busy || !c.testSentAt} title={c.testSentAt ? "" : "Send a test first"} onClick={() => act("launch", () => api.post(`/marketing/campaigns/${id}/launch`, { at: at ? new Date(at).toISOString() : null }), at ? "Scheduled" : "Sending started")}>
                {at ? "Schedule" : "Send now"}
              </button>
            </span>
          )}
          {["running", "scheduled"].includes(c.status) && <button className="btn" onClick={() => act("pause", () => api.post(`/marketing/campaigns/${id}/pause`), "Paused")}>Pause</button>}
          {c.status === "paused" && <button className="btn" onClick={() => act("resume", () => api.post(`/marketing/campaigns/${id}/resume`), "Resumed")}>Resume</button>}
          {["running", "scheduled", "paused"].includes(c.status) && <button className="btn btn-danger" onClick={() => act("cancel", () => api.post(`/marketing/campaigns/${id}/cancel`), "Cancelled")}>Cancel</button>}
          <button className="btn" onClick={() => act("dup", () => api.post(`/marketing/campaigns/${id}/duplicate`), "Copied as a new draft")}>Duplicate</button>
          {c.status !== "running" && <button className="btn btn-ghost" onClick={() => act("del", () => api.delete(`/marketing/campaigns/${id}`).then(onClose), "Deleted")}>Delete</button>}
        </div>
      )}
      {draft && !c.testSentAt && <p className="muted small">Send a test to yourself first — then you can send or schedule it.</p>}
      {!draft && (
        <>
          <div className="seg" style={{ margin: "12px 0" }}>
            {["", "sent", "delivered", "read", "replied", "failed", "skipped", "queued"].map((s) => <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(s)}>{s || "All"}</button>)}
          </div>
          <table className="table">
            <thead><tr><th>Name</th><th>To</th><th>Status</th><th>Sent</th><th>Error</th></tr></thead>
            <tbody>
              {d.recipients.map((r) => (
                <tr key={r._id}><td>{r.name}</td><td className="mono small">{r.to}</td><td>{r.status}</td><td className="small">{when(r.sentAt)}</td><td className="small text-danger">{r.error}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {edit && <CampaignEditor initial={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); load(); onChanged(); }} />}
    </Modal>
  );
}

export function Campaigns() {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [editor, setEditor] = useState(null);
  const [view, setView] = useState(null);
  const load = () => api.get("/marketing/campaigns").then((r) => setList(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, []);
  return (
    <>
      <PageHeader title="Campaigns" subtitle="Broadcast WhatsApp marketing templates or emails to your buyers — with consent, opt-outs and the WhatsApp sending limits respected.">
        {can(user, "marketing", "full") && <button className="btn btn-primary" onClick={() => setEditor({})}>New campaign</button>}
      </PageHeader>
      <div className="card flush">
        {!list ? (
          <Spinner />
        ) : (
          <table className="table table-click">
            <thead><tr><th>Name</th><th>Channel</th><th>Status</th><th className="num">People</th><th className="num">Sent</th><th className="num">Delivered</th><th className="num">Read</th><th className="num">Replied</th><th className="num">Failed</th><th>Created</th></tr></thead>
            <tbody>
              {!list.length && <tr><td colSpan={10} className="muted">No campaigns yet.</td></tr>}
              {list.map((c) => (
                <tr key={c._id} onClick={() => setView(c._id)}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.channel === "whatsapp" ? "WhatsApp" : "Email"}</td>
                  <td><span className={`pill ${C_STATUS[c.status]}`}>{c.status}</span></td>
                  {["recipients", "sent", "delivered", "read", "replied", "failed"].map((k) => <td key={k} className="num">{(c.totals?.[k] || 0).toLocaleString("en-IN")}</td>)}
                  <td className="small">{when(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editor && <CampaignEditor initial={editor} onClose={() => setEditor(null)} onSaved={(c) => { setEditor(null); load(); setView(c._id); }} />}
      {view && <CampaignView id={view} onClose={() => setView(null)} onChanged={() => load().catch(() => {})} />}
    </>
  );
}

/* ====================================================================================================
 * Auto-replies, quick replies, inbox settings, opt-outs
 * ================================================================================================== */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RULE_CH = [["whatsapp", "WhatsApp"], ["messenger", "Messenger"], ["instagram", "Instagram"], ["fb_comment", "FB comments"], ["ig_comment", "IG comments"]];

function RuleModal({ rule, onClose, onSaved }) {
  const [r, setR] = useState({ name: "", active: true, channels: ["whatsapp", "messenger", "instagram"], match: "contains", keywords: "", hours: "any", reply: { kind: "text", text: "", template: "", language: "en" }, ...rule, keywords: (rule.keywords || []).join(", ") });
  const save = async () => {
    try {
      const body = { name: r.name, active: r.active, channels: r.channels, match: r.match, keywords: toList(r.keywords), hours: r.hours, reply: r.reply, position: r.position || 0 };
      const x = r._id ? await api.put(`/marketing/rules/${r._id}`, body) : await api.post("/marketing/rules", body);
      onSaved(x.data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <Modal open title={r._id ? "Edit rule" : "New auto-reply rule"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      <Field label="Name"><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Price question" /></Field>
      <Field label="Channels"><Chips options={RULE_CH} value={r.channels} onChange={(v) => setR({ ...r, channels: v })} /></Field>
      <div className="form-grid">
        <Field label="When the message">
          <select value={r.match} onChange={(e) => setR({ ...r, match: e.target.value })}><option value="contains">contains a keyword</option><option value="exact">is exactly a keyword</option></select>
        </Field>
        <Field label="Business hours">
          <select value={r.hours} onChange={(e) => setR({ ...r, hours: e.target.value })}><option value="any">Any time</option><option value="open">Only when open</option><option value="closed">Only when closed</option></select>
        </Field>
      </div>
      <Field label="Keywords" hint="Comma separated, any language (e.g. price, kitna, rate)"><input value={r.keywords} onChange={(e) => setR({ ...r, keywords: e.target.value })} /></Field>
      <Field label="Reply with">
        <select value={r.reply.kind} onChange={(e) => setR({ ...r, reply: { ...r.reply, kind: e.target.value } })}><option value="text">Text</option><option value="template">WhatsApp template (no variables)</option></select>
      </Field>
      {r.reply.kind === "text" ? (
        <Field label="Reply text"><textarea rows={4} value={r.reply.text || ""} onChange={(e) => setR({ ...r, reply: { ...r.reply, text: e.target.value } })} /></Field>
      ) : (
        <div className="form-grid">
          <Field label="Template name"><input value={r.reply.template || ""} onChange={(e) => setR({ ...r, reply: { ...r.reply, template: e.target.value } })} /></Field>
          <Field label="Language"><input value={r.reply.language || "en"} onChange={(e) => setR({ ...r, reply: { ...r.reply, language: e.target.value } })} /></Field>
        </div>
      )}
      <Toggle checked={r.active} onChange={(v) => setR({ ...r, active: v })} label="Active" />
    </Modal>
  );
}

export function AutoReplies() {
  const { user } = useAuth();
  const [tab, setTab] = useState("rules");
  const writable = can(user, "marketing", "full");
  return (
    <>
      <PageHeader title="Auto-replies" subtitle="Automatic answers in the Inbox — at most one per conversation every 10 minutes, and none once someone from your team has replied." />
      <div className="tabs">
        {[["rules", "Keyword rules"], ["settings", "Away, order status & AI"], ["quick", "Quick replies"], ["optouts", "Opt-outs"]].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "rules" && <Rules writable={writable} />}
      {tab === "settings" && <InboxSettings writable={writable} />}
      {tab === "quick" && <QuickReplies writable={writable} />}
      {tab === "optouts" && <OptOuts writable={writable} />}
    </>
  );
}

function Rules({ writable }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/marketing/rules").then((r) => setList(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!list) return <Spinner />;
  return (
    <div className="card flush">
      <div className="filter-bar">
        <span className="muted small">Rules are checked from the top; the first match replies.</span>
        <span className="spacer" />
        {writable && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ position: list.length })}>New rule</button>}
      </div>
      <table className="table">
        <thead><tr><th>Rule</th><th>Keywords</th><th>Channels</th><th>Hours</th><th>Reply</th><th></th></tr></thead>
        <tbody>
          {!list.length && <tr><td colSpan={6} className="muted">No rules yet.</td></tr>}
          {list.map((r) => (
            <tr key={r._id} className={r.active ? "" : "row-muted"}>
              <td><strong>{r.name}</strong>{!r.active && <span className="muted small"> (off)</span>}</td>
              <td className="small">{r.match === "exact" ? "is " : ""}{r.keywords.join(", ")}</td>
              <td className="small">{(r.channels || []).map((c) => CH_LABEL[c] || c).join(", ") || "All"}</td>
              <td className="small">{r.hours}</td>
              <td className="small clamp">{r.reply.kind === "template" ? `Template ${r.reply.template}` : r.reply.text}</td>
              <td className="nowrap">
                {writable && (
                  <>
                    <button className="link-btn" onClick={() => setEdit(r)}>Edit</button>{" "}
                    <button className="link-btn text-danger" onClick={() => api.delete(`/marketing/rules/${r._id}`).then(load)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <RuleModal rule={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); toast("Saved"); }} />}
    </div>
  );
}

function InboxSettings({ writable }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/marketing/config").then((r) => setCfg(r.data)).catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!cfg) return <Spinner />;
  const days = cfg.businessHours?.days || [];
  const dayOf = (d) => days.find((x) => x.day === d);
  const setDay = (d, patch) => {
    const has = dayOf(d);
    const next = patch === null ? days.filter((x) => x.day !== d) : has ? days.map((x) => (x.day === d ? { ...x, ...patch } : x)) : [...days, { day: d, open: "10:00", close: "19:00", ...patch }];
    setCfg({ ...cfg, businessHours: { ...cfg.businessHours, days: next.sort((a, b) => a.day - b.day) } });
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put("/marketing/config", { businessHours: { enabled: !!cfg.businessHours.enabled, days: days.map(({ day, open, close }) => ({ day, open, close })) }, away: { enabled: !!cfg.away.enabled, text: cfg.away.text || "", channels: cfg.away.channels || DM }, orderStatusReply: { enabled: !!cfg.orderStatusReply.enabled, channels: cfg.orderStatusReply.channels || DM }, ai: { enabled: cfg.ai.enabled !== false, autoDraft: !!cfg.ai.autoDraft, autoSend: cfg.ai.autoSend || [], instructions: cfg.ai.instructions || "" }, stopKeywords: cfg.stopKeywords, retention: { messagesDays: Number(cfg.retention.messagesDays) || 730, mediaDays: Number(cfg.retention.mediaDays) || 180 }, campaignRatePerMinute: Number(cfg.campaignRatePerMinute) || 60 });
      setCfg(r.data);
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const DMOPTS = DM.map((k) => [k, CH_LABEL[k]]);
  return (
    <>
      <div className="card">
        <h3>Business hours (India time)</h3>
        <Toggle checked={cfg.businessHours.enabled} onChange={(v) => setCfg({ ...cfg, businessHours: { ...cfg.businessHours, enabled: v } })} label="Use business hours (for the away message and rules)" />
        {cfg.businessHours.enabled && (
          <div className="hours-grid">
            {DAYS.map((l, d) => (
              <div key={d} className="hours-row">
                <label className="switch-row"><input type="checkbox" checked={!!dayOf(d)} onChange={(e) => setDay(d, e.target.checked ? {} : null)} /> {l}</label>
                {dayOf(d) && (
                  <>
                    <input type="time" value={dayOf(d).open} onChange={(e) => setDay(d, { open: e.target.value })} /> – <input type="time" value={dayOf(d).close} onChange={(e) => setDay(d, { close: e.target.value })} />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Away message</h3>
        <Toggle checked={cfg.away.enabled} onChange={(v) => setCfg({ ...cfg, away: { ...cfg.away, enabled: v } })} label="Reply automatically outside business hours" />
        <Field label="Message"><textarea rows={3} value={cfg.away.text || ""} onChange={(e) => setCfg({ ...cfg, away: { ...cfg.away, text: e.target.value } })} /></Field>
        <Chips options={DMOPTS} value={cfg.away.channels || []} onChange={(v) => setCfg({ ...cfg, away: { ...cfg.away, channels: v } })} />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Order status answers</h3>
        <Toggle checked={cfg.orderStatusReply.enabled} onChange={(v) => setCfg({ ...cfg, orderStatusReply: { ...cfg.orderStatusReply, enabled: v } })} label="Answer “where is my order?” with the latest order's status and tracking link" />
        <p className="muted small">Finds the order by the sender's phone number (or an order number in the message, only if it's theirs).</p>
        <Chips options={DMOPTS} value={cfg.orderStatusReply.channels || []} onChange={(v) => setCfg({ ...cfg, orderStatusReply: { ...cfg.orderStatusReply, channels: v } })} />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>AI drafts (Google Gemini)</h3>
        <p className="muted small">Uses the Gemini key in Settings → Integrations. Drafts use the conversation and the customer's orders, and wait for your approval in the Inbox.</p>
        <Toggle checked={cfg.ai.enabled !== false} onChange={(v) => setCfg({ ...cfg, ai: { ...cfg.ai, enabled: v } })} label="Allow AI drafts" />
        <Toggle checked={cfg.ai.autoDraft} onChange={(v) => setCfg({ ...cfg, ai: { ...cfg.ai, autoDraft: v } })} label="Draft a reply automatically for every new message" />
        <div className="label-sm" style={{ marginTop: 8 }}>Send AI replies without approval on (off by default)</div>
        <Chips options={Object.entries(CH_LABEL)} value={cfg.ai.autoSend || []} onChange={(v) => setCfg({ ...cfg, ai: { ...cfg.ai, autoSend: v } })} />
        <Field label="Instructions for the AI" hint="e.g. We deliver in 5–7 days. Returns within 7 days of delivery. Never offer discounts."><textarea rows={3} value={cfg.ai.instructions || ""} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, instructions: e.target.value } })} /></Field>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Opt-out words, sending speed, data kept</h3>
        <div className="form-grid">
          <Field label="WhatsApp opt-out words" hint="A message that is exactly one of these adds the number to the opt-out list"><input value={(cfg.stopKeywords || []).join(", ")} onChange={(e) => setCfg({ ...cfg, stopKeywords: toList(e.target.value) })} /></Field>
          <Field label="Campaign messages per minute"><input type="number" min="1" max="1000" value={cfg.campaignRatePerMinute} onChange={(e) => setCfg({ ...cfg, campaignRatePerMinute: e.target.value })} /></Field>
          <Field label="Keep messages for (days)"><input type="number" min="30" value={cfg.retention.messagesDays} onChange={(e) => setCfg({ ...cfg, retention: { ...cfg.retention, messagesDays: e.target.value } })} /></Field>
          <Field label="Keep photos and files for (days)"><input type="number" min="7" value={cfg.retention.mediaDays} onChange={(e) => setCfg({ ...cfg, retention: { ...cfg.retention, mediaDays: e.target.value } })} /></Field>
        </div>
      </div>
      {writable && <div className="row-actions"><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>}
    </>
  );
}

function QuickReplies({ writable }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/marketing/quick-replies").then((r) => setList(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, []);
  if (!list) return <Spinner />;
  const save = async () => {
    try {
      const body = { title: edit.title, shortcut: edit.shortcut || "", text: edit.text };
      if (edit._id) await api.put(`/marketing/quick-replies/${edit._id}`, body);
      else await api.post("/marketing/quick-replies", body);
      setEdit(null);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="card flush">
      <div className="filter-bar">
        <span className="muted small">Type “/shortcut” in the reply box, or pick from Quick replies.</span>
        <span className="spacer" />
        {writable && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ title: "", shortcut: "", text: "" })}>New quick reply</button>}
      </div>
      <table className="table">
        <thead><tr><th>Title</th><th>Shortcut</th><th>Text</th><th></th></tr></thead>
        <tbody>
          {!list.length && <tr><td colSpan={4} className="muted">None yet.</td></tr>}
          {list.map((q) => (
            <tr key={q._id}>
              <td><strong>{q.title}</strong></td>
              <td className="mono">{q.shortcut ? `/${q.shortcut}` : ""}</td>
              <td className="small clamp">{q.text}</td>
              <td className="nowrap">{writable && <><button className="link-btn" onClick={() => setEdit(q)}>Edit</button> <button className="link-btn text-danger" onClick={() => api.delete(`/marketing/quick-replies/${q._id}`).then(load)}>Delete</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={!!edit} title="Quick reply" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit?.title || !edit?.text} onClick={save}>Save</button></>}>
        <Field label="Title"><input value={edit?.title || ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
        <Field label="Shortcut" hint="Without the slash, e.g. thanks"><input value={edit?.shortcut || ""} onChange={(e) => setEdit({ ...edit, shortcut: e.target.value.replace(/[^\w-]/g, "") })} /></Field>
        <Field label="Text"><textarea rows={5} value={edit?.text || ""} onChange={(e) => setEdit({ ...edit, text: e.target.value })} /></Field>
      </Modal>
    </div>
  );
}

function OptOuts({ writable }) {
  const [d, setD] = useState(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [add, setAdd] = useState({ channel: "whatsapp", value: "" });
  const [busy, setBusy] = useState(false);
  const load = () => api.get("/marketing/optouts", { params: { q: dq } }).then((r) => setD(r.data));
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [dq]);
  const SRC = useMemo(() => ({ stop_keyword: "Sent STOP", unsubscribe_link: "Unsubscribe link", staff: "Added by staff" }), []);
  return (
    <>
      {writable && (
        <div className="card">
          <div className="inline-add">
            <select value={add.channel} onChange={(e) => setAdd({ ...add, channel: e.target.value })} style={{ width: 140 }}><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select>
            <input value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} placeholder={add.channel === "whatsapp" ? "Phone number" : "Email address"} />
            <button className="btn btn-primary" onClick={() => api.post("/marketing/optouts", add).then(() => { setAdd({ ...add, value: "" }); load(); toast("Added to the opt-out list"); }).catch((e) => toast(errMsg(e), "error"))}>Add</button>
            <button className="btn" disabled={busy} title="Read email / SMS marketing consent of Shopify customers (also runs every hour)" onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post("/marketing/consent/sync");
                toast(`Shopify consent synced (${r.data.synced} customers)`);
              } catch (e) {
                toast(errMsg(e), "error");
              }
              setBusy(false);
            }}>{busy ? "Syncing…" : "Sync Shopify consent"}</button>
          </div>
        </div>
      )}
      <div className="card flush" style={{ marginTop: 14 }}>
        <div className="filter-bar"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a number or email" style={{ maxWidth: 320 }} /> <span className="muted small">{d?.total ?? ""} opted out</span></div>
        {!d ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Channel</th><th>Number / email</th><th>How</th><th>When</th><th></th></tr></thead>
            <tbody>
              {!d.items.length && <tr><td colSpan={5} className="muted">Nobody has opted out.</td></tr>}
              {d.items.map((x) => (
                <tr key={x._id}>
                  <td>{x.channel === "whatsapp" ? "WhatsApp" : "Email"}</td>
                  <td className="mono">{x.value}</td>
                  <td className="small">{SRC[x.source] || x.source}{x.note ? ` · ${x.note}` : ""}</td>
                  <td className="small">{when(x.at)}</td>
                  <td>{writable && <button className="link-btn text-danger" onClick={() => api.delete(`/marketing/optouts/${x._id}`).then(load)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
