import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { PageHeader, Spinner, toast } from "../components/ui";

// Banking → Auto-import from email: the mailbox the bank emails statements to (a Gmail with an app password),
// which bank account each statement goes to (by account number), and the statements' file passwords.
const fmt = (t) => (t ? new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export function BankEmailImport() {
  const [banks, setBanks] = useState(null);
  const [f, setF] = useState(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(7);

  const take = (feed, bankList = banks) => {
    const by = Object.fromEntries((feed.accounts || []).map((a) => [a.code, a]));
    setF({
      ...feed,
      rows: (bankList || []).map((b) => ({
        code: b.code,
        name: b.name,
        accountNumber: by[b.code]?.accountNumber ?? "",
        cards: by[b.code]?.cards ?? "",
        suggested: b.accountCode || "",
        enabled: by[b.code] ? by[b.code].enabled : false,
        hasFilePassword: !!by[b.code]?.hasFilePassword,
        filePassword: "",
        clearFilePassword: false,
      })),
    });
  };
  useEffect(() => {
    Promise.all([api.get("/banking/accounts"), api.get("/banking/email-feed")])
      .then(([a, feed]) => {
        const list = a.data.filter((x) => x.active !== false && !/^cash/i.test(x.name || ""));
        setBanks(list);
        take(feed.data, list);
      })
      .catch((e) => toast(errMsg(e), "error"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <Spinner />;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setRow = (code, k, v) => setF((x) => ({ ...x, rows: x.rows.map((r) => (r.code === code ? { ...r, [k]: v } : r)) }));

  const save = async (enabledOverride) => {
    const missing = f.rows.filter((r) => r.enabled && !r.accountNumber.trim());
    if (missing.length) {
      toast(`Enter the account number for ${missing.map((r) => r.name).join(", ")}`, "error");
      return false;
    }
    setBusy(true);
    try {
      const { data } = await api.put("/banking/email-feed", {
        enabled: enabledOverride ?? f.enabled,
        host: f.host,
        port: Number(f.port) || 993,
        user: f.user,
        ...(pass ? { password: pass } : {}),
        senders: f.senders,
        alerts: f.alerts,
        accounts: f.rows
          .filter((r) => r.enabled && r.accountNumber.trim())
          .map((r) => ({
            code: r.code,
            accountNumber: r.accountNumber.trim(),
            cards: r.cards.trim(),
            enabled: true,
            ...(r.filePassword ? { filePassword: r.filePassword } : {}),
            clearFilePassword: r.clearFilePassword,
          })),
      });
      setPass("");
      take(data);
      toast("Saved");
      return true;
    } catch (e) {
      toast(errMsg(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const run = async (back) => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const { data } = await api.post("/banking/email-feed/run", back ? { days: back } : {});
      take(data);
      const ok = (data.results || []).filter((r) => !r.error);
      const bad = (data.results || []).filter((r) => r.error);
      if (data.lastError) toast(data.lastError, "error");
      else
        toast(
          ok.length || bad.length
            ? `${ok.reduce((s, r) => s + r.imported, 0)} new line(s) imported from ${ok.length} statement(s)${bad.length ? ` · ${bad.length} couldn't be read (see below)` : ""}`
            : "Mailbox checked — no new statements",
          bad.length ? "error" : undefined,
        );
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };

  return (
    <div>
      <PageHeader title="Auto-import statements from email" subtitle="OrdexaGo reads the statements your bank emails and adds them to the bank account every 15 minutes." back="/banking" />

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>1. Mailbox the bank sends statements to</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Use a Gmail that gets only bank / business mail. Gmail needs an <strong>app password</strong>, not your normal password: Google Account → Security → 2-Step
          Verification (turn on) → <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App passwords</a> → create one named
          “OrdexaGo” and paste the 16 letters here. OrdexaGo only reads mail — it never deletes, moves or marks anything as read.
        </p>
        <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label className="field">
            <span>Email address</span>
            <input value={f.user} onChange={(e) => set("user", e.target.value)} placeholder="statements@gmail.com" autoComplete="off" />
          </label>
          <label className="field">
            <span>App password {f.hasPass && <span className="muted">(saved — type to change)</span>}</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={f.hasPass ? "••••••••••••••••" : "16-letter app password"} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>Only mail from (optional)</span>
            <input value={f.senders} onChange={(e) => set("senders", e.target.value)} placeholder="corp.stmnts@icici.bank.in, hdfcbank.net" />
          </label>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="small muted">Not Gmail?</summary>
          <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            <label className="field">
              <span>IMAP server</span>
              <input value={f.host} onChange={(e) => set("host", e.target.value)} />
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>Port</span>
              <input value={f.port} onChange={(e) => set("port", e.target.value)} />
            </label>
          </div>
        </details>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. Bank accounts to fill automatically</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Tick the account and enter its account number as printed in the statement. A statement goes to the account whose number is in the file. If the bank
          locks its statement files with a password, enter it here (stored encrypted, never shown again).
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Bank account</th>
                <th>Account number</th>
                <th title="Card alerts (ATM, POS) name the debit card, not the account">Debit cards (last 4)</th>
                <th>Statement file password</th>
              </tr>
            </thead>
            <tbody>
              {f.rows.map((r) => (
                <tr key={r.code}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => {
                        setRow(r.code, "enabled", e.target.checked);
                        if (e.target.checked && !r.accountNumber && r.suggested) setRow(r.code, "accountNumber", r.suggested);
                      }}
                    />
                  </td>
                  <td>{r.name}</td>
                  <td>
                    <input value={r.accountNumber} disabled={!r.enabled} onChange={(e) => setRow(r.code, "accountNumber", e.target.value)} placeholder="e.g. 019105007866" style={{ width: 180 }} />
                  </td>
                  <td>
                    <input value={r.cards} disabled={!r.enabled} onChange={(e) => setRow(r.code, "cards", e.target.value)} placeholder="e.g. 4479" style={{ width: 110 }} />
                  </td>
                  <td>
                    <input
                      type="password"
                      value={r.filePassword}
                      disabled={!r.enabled}
                      onChange={(e) => setRow(r.code, "filePassword", e.target.value)}
                      placeholder={r.hasFilePassword && !r.clearFilePassword ? "saved — type to change" : "only if the file is locked"}
                      autoComplete="new-password"
                      style={{ width: 190 }}
                    />
                    {r.hasFilePassword && (
                      <label className="small muted" style={{ marginLeft: 8 }}>
                        <input type="checkbox" checked={r.clearFilePassword} onChange={(e) => setRow(r.code, "clearFilePassword", e.target.checked)} /> remove
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            <strong>Import automatically every 15 minutes</strong>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }} title="One line per debit / credit alert email (e.g. HDFC InstaAlerts), confirmed later by the statement">
            <input type="checkbox" checked={f.alerts} onChange={(e) => set("alerts", e.target.checked)} />
            Also read transaction alert emails
          </label>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={() => save()}>
            Save
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run()}>
            {busy ? "Working…" : "Save & check mail now"}
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span>Last checked: {fmt(f.lastRunAt)}</span>
          {f.lastError && <span style={{ color: "#b91c1c" }}>⚠ {f.lastError}</span>}
          <span style={{ flex: 1 }} />
          <span>
            Re-read emails from the last{" "}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[3, 7, 15, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>{" "}
            <button className="btn btn-sm" disabled={busy} onClick={() => run(days)} title="Lines already in OrdexaGo are skipped">
              Re-read
            </button>
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Recent imports</h3>
        {!f.log.length ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Checked</th>
                  <th>Email</th>
                  <th>File</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {f.log.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{fmt(l.at)}</td>
                    <td className="small">
                      {l.subject}
                      <div className="muted">
                        {l.from} · {fmt(l.mailAt)}
                      </div>
                    </td>
                    <td className="small">{l.file || (l.alert ? "Alert" : "—")}</td>
                    <td className="small">
                      {l.error ? (
                        <span style={{ color: "#b91c1c" }}>{l.error}</span>
                      ) : (
                        <>
                          <strong>{l.alert ? `₹${Math.abs(l.amount || 0).toLocaleString("en-IN")} ${l.amount < 0 ? "debit" : "credit"}` : `${l.imported} new`}</strong> into {f.rows.find((r) => r.code === l.account)?.name || l.account}
                          {l.skipped ? ` · ${l.skipped} already in` : ""}
                          {l.confirmed ? ` · ${l.confirmed} alert line(s) confirmed` : ""}
                          {l.notInStatement ? ` · ⚠ ${l.notInStatement} alert line(s) not in the statement` : ""}
                          {l.rules ? ` · ${l.rules} categorised by rules` : ""}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
