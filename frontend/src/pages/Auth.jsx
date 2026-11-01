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
        <p className="auth-foot">© {new Date().getFullYear()} OrdexaGo</p>
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

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/login", form);
      signIn(data);
      navigate("/");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to OrdexaGo."
      footer={
        <>
          New to OrdexaGo? <Link to="/signup">Create an account</Link>
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
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/signup", form);
      if (data.token) {
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
          <Field label="Password" required hint="At least 8 characters, with letters and numbers">
            <input type="password" required minLength={8} value={form.password} onChange={set("password")} />
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
          <Field label="New password" hint="At least 8 characters, with letters and numbers">
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
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
