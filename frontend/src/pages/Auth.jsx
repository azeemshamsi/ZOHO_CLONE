import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES } from "../lib/constants";
import Logo from "../components/Logo";
import { Field } from "../components/ui";

export function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="auth">
      <div className="auth-side">
        <Logo size={40} light tagline />
        <div className="auth-pitch">
          <h2>Run your books, not the other way round.</h2>
          <ul>
            <li>GST-ready invoices with CGST, SGST and IGST worked out for you</li>
            <li>Know who owes you and what's overdue at a glance</li>
            <li>Record payments by UPI, bank, cash or cheque</li>
          </ul>
        </div>
        <p className="auth-foot">
          © {new Date().getFullYear()} OrdexaGo · <Link to="/privacy" style={{ color: "inherit" }}>Privacy</Link>
        </p>
      </div>
      <div className="auth-main">
        <div className="auth-card">
          <div className="auth-mobile-logo">
            <Logo size={32} />
          </div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
          {children}
        </div>
        {footer && <div className="auth-switch">{footer}</div>}
      </div>
    </div>
  );
}

export const PASSWORD_HINT = "At least 12 characters with upper- and lower-case letters, a number and a symbol. Not your name, your email or a common password.";

/**
 * Sign-in steps after the password: change an expired password, enter the two-step code (or a recovery code),
 * or set up two-step login (QR code) and save the recovery codes. `start` is the server's answer.
 */
export function SignInSteps({ start, onCancel }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [r, setR] = useState(start);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState({ password: "", confirm: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [session, setSession] = useState(null); // signed in, showing the recovery codes first
  const [saved, setSaved] = useState(false);
  const enter = (data) => {
    signIn(data);
    navigate("/");
  };
  const post = async (url, body) => {
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(url, body);
      setCode("");
      if (data.token) {
        if (data.recoveryCodes) setSession(data);
        else enter(data);
      } else setR(data);
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy(false);
  };
  const back = (
    <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
      Back to sign in
    </button>
  );

  if (session) {
    const text = session.recoveryCodes.join("\n");
    return (
      <AuthShell title="Save your recovery codes" subtitle="Two-step login is on. If you lose your phone, each of these codes lets you sign in once.">
        <div className="stack">
          <pre className="mono" style={{ background: "var(--bg-soft, #f4f5f7)", padding: 12, borderRadius: 8, columns: 2, fontSize: 15 }}>{text}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(text)}>
              Copy
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([`OrdexaGo recovery codes for ${session.user?.email}\n\n${text}\n`], { type: "text/plain" }));
                a.download = "ordexago-recovery-codes.txt";
                a.click();
              }}
            >
              Download
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved these codes somewhere safe
          </label>
          <button className="btn btn-primary btn-block" disabled={!saved} onClick={() => enter(session)}>
            Continue
          </button>
        </div>
      </AuthShell>
    );
  }

  if (r.step === "change_password")
    return (
      <AuthShell title="Choose a new password" subtitle={r.message}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.password !== pw.confirm) return setError("Passwords don't match");
            post("/auth/login/change-password", { ticket: r.ticket, password: pw.password });
          }}
        >
          <Field label="New password" hint={PASSWORD_HINT}>
            <input type="password" required minLength={12} autoFocus autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
          </Field>
          <Field label="Confirm new password">
            <input type="password" required autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Field>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Saving…" : "Save and continue"}
          </button>
          {back}
        </form>
      </AuthShell>
    );

  if (r.step === "totp")
    return (
      <AuthShell title="Two-step login" subtitle={recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            post("/auth/login/totp", { ticket: r.ticket, code });
          }}
        >
          <Field label={recovery ? "Recovery code" : "Code"}>
            {recovery ? (
              <input required autoFocus autoComplete="off" className="mono" placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} />
            ) : (
              <input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="mono" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            )}
          </Field>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Checking…" : "Verify"}
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => (setRecovery(!recovery), setCode(""), setError(""))}>
            {recovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code"}
          </button>
          {back}
        </form>
      </AuthShell>
    );

  if (r.step === "totp_setup")
    return (
      <AuthShell title="Set up two-step login" subtitle="Your role needs a second step at sign-in. It takes a minute, once.">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            post("/auth/login/totp-setup", { ticket: r.ticket, code });
          }}
        >
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Install an authenticator app on your phone — Google Authenticator, Microsoft Authenticator or Authy.</li>
            <li>In the app, add an account and scan this QR code.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <div className="center">
            <img src={r.qr} alt="QR code for your authenticator app" width={200} height={200} style={{ background: "#fff", padding: 6, borderRadius: 8 }} />
          </div>
          <p className="muted small center" style={{ wordBreak: "break-all" }}>
            Can't scan? Enter this key: <span className="mono">{r.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
          </p>
          <Field label="6-digit code">
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="mono" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Checking…" : "Turn on and continue"}
          </button>
          {back}
        </form>
      </AuthShell>
    );

  return (
    <AuthShell title="Sign in">
      <div className="alert alert-error">Something went wrong. Please sign in again.</div>
      {back}
    </AuthShell>
  );
}

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState(() => {
    try {
      const m = sessionStorage.getItem("ordexago_blocked") || "";
      sessionStorage.removeItem("ordexago_blocked");
      return m;
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // next sign-in step from the server

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/login", form);
      if (data.step) {
        setPending(data);
        setForm((f) => ({ ...f, password: "" }));
      } else {
        signIn(data);
        navigate("/");
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (pending) return <SignInSteps start={pending} onCancel={() => setPending(null)} />;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to OrdexaGo."
      footer={
        <>
          Want OrdexaGo for your business? Write to <a href="mailto:help@ordexago.com">help@ordexago.com</a>
        </>
      }
    >
      <form onSubmit={submit} className="stack">
        <Field label="Email">
          <input type="email" required autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password">
          <input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <div className="right">
          <Link to="/forgot-password" className="small">
            Forgot password?
          </Link>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}

export function Signup() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", organizationName: "", state: "27" });
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/signup", form);
      if (data.step) setPending(data);
      else if (data.token) {
        signIn(data);
        navigate("/");
      } else {
        setInfo(data.message);
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (pending) return <SignInSteps start={pending} onCancel={() => setPending(null)} />;
  return (
    <AuthShell
      title="Create your OrdexaGo account"
      subtitle="Set up your organization in under a minute."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      {info ? (
        <div className="alert alert-success">{info}</div>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="Your name" required>
            <input required autoFocus value={form.name} onChange={set("name")} />
          </Field>
          <Field label="Work email" required>
            <input type="email" required value={form.email} onChange={set("email")} />
          </Field>
          <Field label="Password" required hint={PASSWORD_HINT}>
            <input type="password" required minLength={12} autoComplete="new-password" value={form.password} onChange={set("password")} />
          </Field>
          <Field label="Organization name" required>
            <input required value={form.organizationName} onChange={set("organizationName")} />
          </Field>
          <Field label="State / Union Territory" required hint="Used to decide CGST+SGST or IGST on invoices">
            <select value={form.state} onChange={set("state")}>
              {STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/forgot-password", { email });
      setMsg({ ok: true, text: data.message });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={<Link to="/login">Back to sign in</Link>}
    >
      <form onSubmit={submit} className="stack">
        <Field label="Email">
          <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {msg && <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`}>{msg.text}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          Send reset link
        </button>
      </form>
    </AuthShell>
  );
}

export function ResetPassword() {
  const { id, token } = useParams();
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.post(`/auth/reset-password/${id}/${token}`, { password });
      setMsg({ ok: true, text: data.message });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    }
  };
  return (
    <AuthShell title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      {msg?.ok ? (
        <div className="alert alert-success">
          {msg.text} <Link to="/login">Sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="New password" hint={PASSWORD_HINT}>
            <input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {msg && <div className="alert alert-error">{msg.text}</div>}
          <button className="btn btn-primary btn-block">Update password</button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmail() {
  const { id, token } = useParams();
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    api
      .get(`/auth/verify/${id}/${token}`)
      .then(({ data }) => setMsg({ ok: true, text: data.message }))
      .catch((err) => setMsg({ ok: false, text: errMsg(err) }));
  }, [id, token]);
  return (
    <AuthShell title="Email verification" footer={<Link to="/login">Go to sign in</Link>}>
      {msg ? <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`}>{msg.text}</div> : <p>Verifying…</p>}
    </AuthShell>
  );
}
