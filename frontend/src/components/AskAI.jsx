import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";

// "Ask OrdexaGo": a chat panel (bottom-right) that answers questions from the company's own data with Gemini.
// The assistant only reads, and only what the signed-in user's role may see.

const SUGGESTIONS = [
  "How much does Amazon owe us?",
  "Profit this month vs last month",
  "Top 10 selling items this month",
  "Which vendors do we owe the most?",
  "RTO rate by courier in the last 30 days",
  "Cash and bank balance today",
];

// Small markdown: **bold**, bullet / numbered lists, | tables |, line breaks.
export function MiniMarkdown({ text }) {
  const blocks = [];
  const lines = String(text || "").split("\n");
  let i = 0;
  const inline = (s, k) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith("**") && p.endsWith("**") ? <strong key={`${k}-${j}`}>{p.slice(2, -2)}</strong> : <span key={`${k}-${j}`}>{p}</span>));
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().slice(1, -1).split("|").map((c) => c.trim()));
      blocks.push(
        <div key={i} style={{ overflowX: "auto" }}>
          <table className="table" style={{ fontSize: 12.5, margin: "6px 0" }}>
            <thead>
              <tr>{cells[0]?.map((c, j) => <th key={j}>{inline(c, j)}</th>)}</tr>
            </thead>
            <tbody>
              {cells.slice(1).map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, `${k}${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const items = [];
      const ordered = /^\s*\d/.test(l);
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={i} style={{ margin: "4px 0", paddingLeft: 20 }}>
          {items.map((t, j) => (
            <li key={j}>{inline(t, j)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (/^#{1,4}\s/.test(l)) blocks.push(<div key={i} style={{ fontWeight: 600, marginTop: 6 }}>{inline(l.replace(/^#+\s/, ""), i)}</div>);
    else if (l.trim()) blocks.push(<div key={i}>{inline(l, i)}</div>);
    else blocks.push(<div key={i} style={{ height: 6 }} />);
    i++;
  }
  return <div style={{ lineHeight: 1.5 }}>{blocks}</div>;
}

export default function AskAI() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem("askai") || "[]");
    } catch {
      return [];
    }
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef();
  const input = useRef();
  useEffect(() => {
    try {
      sessionStorage.setItem("askai", JSON.stringify(msgs.slice(-30)));
    } catch {}
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 50);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = async (text) => {
    const t = String(text ?? q).trim();
    if (!t || busy) return;
    const next = [...msgs, { role: "user", text: t }];
    setMsgs(next);
    setQ("");
    setBusy(true);
    try {
      const { data } = await api.post("/ai/ask", { messages: next.filter((m) => !m.error).slice(-12).map(({ role, text }) => ({ role, text })) });
      setMsgs((m) => [...m, { role: "model", text: data.text }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "model", text: errMsg(e), error: true }]);
    }
    setBusy(false);
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Ask OrdexaGo (AI)"
          aria-label="Ask OrdexaGo"
          className="no-print"
          style={{ position: "fixed", right: 18, bottom: 18, zIndex: 900, border: 0, borderRadius: 999, padding: "11px 16px", background: "var(--brand, #1d4ed8)", color: "#fff", fontWeight: 600, boxShadow: "0 6px 20px rgba(0,0,0,.18)", cursor: "pointer", display: "flex", gap: 8, alignItems: "center" }}
        >
          <span aria-hidden>✨</span> Ask AI
        </button>
      )}
      {open && (
        <div
          className="no-print"
          role="dialog"
          aria-label="Ask OrdexaGo"
          style={{ position: "fixed", right: 12, bottom: 12, zIndex: 950, width: "min(440px, calc(100vw - 24px))", height: "min(640px, calc(100vh - 24px))", background: "var(--surface, #fff)", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.22)", display: "flex", flexDirection: "column", border: "1px solid var(--border, #e5e7eb)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
            <strong style={{ flex: 1 }}>✨ Ask OrdexaGo</strong>
            {msgs.length > 0 && (
              <button className="link-btn small" onClick={() => setMsgs([])} title="Start a new conversation">
                New chat
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {!msgs.length && (
              <div>
                <p className="muted small" style={{ marginTop: 0 }}>
                  Ask about your sales, dues, profit, stock, GST or store orders in plain words — English, Hindi or Hinglish. Answers come from your own data, only what your role can see.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="btn btn-sm" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "92%",
                  padding: "8px 12px",
                  borderRadius: 10,
                  fontSize: 14,
                  background: m.role === "user" ? "var(--brand, #1d4ed8)" : m.error ? "#fef2f2" : "var(--surface-2, #f3f4f6)",
                  color: m.role === "user" ? "#fff" : m.error ? "#b91c1c" : "inherit",
                }}
              >
                {m.role === "user" ? m.text : <MiniMarkdown text={m.text} />}
              </div>
            ))}
            {busy && <div className="muted small">Looking at your data…</div>}
            <div ref={end} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--border, #e5e7eb)" }}
          >
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about your business…" style={{ flex: 1, minWidth: 0 }} maxLength={2000} />
            <button className="btn btn-primary" disabled={busy || !q.trim()}>
              Ask
            </button>
          </form>
        </div>
      )}
    </>
  );
}

// Dashboard card: today's briefing written by AI from the same data.
export function InsightsCard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    load(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async (refresh) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.get("/ai/insights", { params: refresh ? { refresh: 1 } : {} });
      setD(r.data);
    } catch (e) {
      setErr(errMsg(e));
    }
    setBusy(false);
  };
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 1 }}>✨ Today's briefing</strong>
        {d && (
          <span className="muted small">{new Date(d.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={() => load(!!d)}>
          {busy ? "Thinking…" : d ? "Refresh" : "Get briefing"}
        </button>
      </div>
      {err && <p className="small" style={{ color: "#b91c1c", marginBottom: 0 }}>{err}</p>}
      {!d && !err && !busy && <p className="muted small" style={{ marginBottom: 0 }}>AI reads your dues, cash, sales, expenses and store orders and tells you what needs attention today.</p>}
      {d && (
        <div style={{ marginTop: 8, fontSize: 14 }}>
          <MiniMarkdown text={d.text} />
        </div>
      )}
    </div>
  );
}
