import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Field, Spinner, toast } from "../components/ui";
import { PASSWORD_HINT } from "./Auth";

// Your own sign-in security: password and two-step login.
export default function Account() {
  const { user, refresh } = useAuth();
  const [tf, setTf] = useState(null);
  const load = () => api.get("/auth/2fa").then((r) => setTf(r.data)).catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <PageHeader title="Account security" subtitle={`${user?.name} · ${user?.email}`} />
      <ChangePassword />
      {!tf ? <Spinner /> : <TwoStep tf={tf} onChange={() => (load(), refresh())} />}
    </>
  );
}

function ChangePassword() {
  const [f, setF] = useState({ current: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError("New passwords don't match");
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/change-password", { current: f.current, password: f.password });
      localStorage.setItem("mgi_token", data.token);
      setF({ current: "", password: "", confirm: "" });
      toast(data.message);
    } catch (err) {
      setError(errMsg(err));
    }
    setBusy(false);
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h4 className="section-title" style={{ marginTop: 0 }}>Change password</h4>
      <div className="form-grid" style={{ maxWidth: 480 }}>
        <Field label="Current password">
          <input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
        </Field>
        <Field label="New password" hint={PASSWORD_HINT}>
          <input type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Confirm new password">
          <input type="password" required autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <p className="muted small">Passwords expire after a year. Changing it signs you out on every other device.</p>
      <div className="form-footer">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

function Codes({ codes, onDone }) {
  const text = codes.join("\n");
  return (
    <div className="stack">
      <div className="alert alert-success">Save these recovery codes somewhere safe. Each one lets you sign in once if you lose your phone. They won't be shown again.</div>
      <pre className="mono" style={{ background: "var(--bg-soft, #f4f5f7)", padding: 12, borderRadius: 8, columns: 2, maxWidth: 420 }}>{text}</pre>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(text)}>
          Copy
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([`OrdexaGo recovery codes\n\n${text}\n`], { type: "text/plain" }));
            a.download = "ordexago-recovery-codes.txt";
            a.click();
          }}
        >
          Download
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function TwoStep({ tf, onChange }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <div className="card form" style={{ marginTop: 18 }}>
      <h4 className="section-title" style={{ marginTop: 0 }}>
        Two-step login <span className="muted small">{tf.enabled ? `On${tf.enabledAt ? ` since ${new Date(tf.enabledAt).toLocaleDateString("en-IN")}` : ""} · ${tf.recoveryLeft} recovery code${tf.recoveryLeft === 1 ? "" : "s"} left` : "Off"}</span>
      </h4>
      {codes ? (
        <Codes codes={codes} onDone={() => (setCodes(null), onChange())} />
      ) : tf.enabled ? (
        <form
          className="form-grid"
          style={{ maxWidth: 480 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const { data } = await api.post("/auth/2fa/recovery-codes", { code });
              setCode("");
              setCodes(data.recoveryCodes);
            });
          }}
        >
          <p className="muted small">Running low on recovery codes? Enter a code from your authenticator app to get 10 new ones (the old ones stop working). Lost your phone? Ask an admin to reset your two-step login.</p>
          <Field label="Code from your app">
            <input required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="mono" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <div>
            <button className="btn" disabled={busy}>
              New recovery codes
            </button>
          </div>
        </form>
      ) : setup ? (
        <form
          className="stack"
          style={{ maxWidth: 480 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const { data } = await api.post("/auth/2fa/enable", { code });
              localStorage.setItem("mgi_token", data.token);
              setSetup(null);
              setCode("");
              setCodes(data.recoveryCodes);
            });
          }}
        >
          <p className="small">Scan this with Google Authenticator, Microsoft Authenticator or Authy, then enter the 6-digit code.</p>
          <img src={setup.qr} alt="QR code" width={200} height={200} style={{ background: "#fff", padding: 6, borderRadius: 8 }} />
          <p className="muted small" style={{ wordBreak: "break-all" }}>
            Key: <span className="mono">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
          </p>
          <Field label="6-digit code">
            <input required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="mono" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <div>
            <button className="btn btn-primary" disabled={busy}>
              Turn on
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted small">{tf.required ? "Your role needs two-step login — you'll set it up at your next sign-in, or now:" : "Add a second step at sign-in with an authenticator app on your phone."}</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setSetup((await api.post("/auth/2fa/setup")).data))}>
            Set up two-step login
          </button>
        </>
      )}
    </div>
  );
}
