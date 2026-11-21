import { useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { toast } from "./ui";
import { readB64 } from "./PaymentProofs";

// Shared by the seller's Support tab and the team's ticket desk.

export const STATUS_PILL = {
  open: "pill-amber",
  in_progress: "pill-blue",
  waiting: "pill-amber",
  resolved: "pill-green",
  closed: "",
};
export const when = (d) =>
  new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// Screenshots: choose files, take a photo, or paste (Ctrl+V) into the box.
export function FilePicker({ files, setFiles }) {
  const ref = useRef();
  const add = (list) => {
    const ok = [...list].filter(
      (f) =>
        /^image\/|pdf$/.test(f.type) ||
        /\.(png|jpe?g|webp|gif|heic|pdf)$/i.test(f.name),
    );
    const big = ok.find((f) => f.size > 10 * 1024 * 1024);
    if (big) return toast(`${big.name} is over 10 MB`, "error");
    setFiles([...files, ...ok].slice(0, 5));
  };
  return (
    <div
      onPaste={(e) =>
        e.clipboardData?.files?.length && add(e.clipboardData.files)
      }
    >
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => ref.current?.click()}
        disabled={files.length >= 5}
      >
        + Screenshot
      </button>
      <input
        ref={ref}
        type="file"
        hidden
        multiple
        accept="image/*,application/pdf"
        onChange={(e) => (add(e.target.files), (e.target.value = ""))}
      />
      <span className="muted small" style={{ marginLeft: 8 }}>
        up to 5 · or paste one here
      </span>
      {files.map((f, i) => (
        <div key={i} className="small">
          {f.name || "screenshot.png"} ·{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => setFiles(files.filter((_, j) => j !== i))}
          >
            remove
          </button>
        </div>
      ))}
    </div>
  );
}

export const filesPayload = (files) =>
  Promise.all(
    files.map(async (f) => ({
      name: f.name || "screenshot.png",
      type: f.type || "",
      data: await readB64(f),
    })),
  );

// The conversation. fileUrl(msgFile) → API path for that file.
export function Thread({ messages, fileUrl, team = false }) {
  const open = async (f) => {
    const w = window.open("", "_blank");
    try {
      const r = await api.get(fileUrl(f), { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      if (w) w.location = url;
      else window.open(url, "_blank");
    } catch (e) {
      if (w) w.close();
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="ticket-thread">
      {messages.map((m) =>
        m.from === "system" ? (
          <div
            key={m._id}
            className="muted small center"
            style={{ margin: "6px 0" }}
          >
            {m.text} · {m.name ? `${m.name}, ` : ""}
            {when(m.at)}
          </div>
        ) : (
          <div
            key={m._id}
            className={`ticket-msg ${m.from === (team ? "team" : "seller") ? "mine" : ""} ${m.internal ? "internal" : ""}`}
          >
            <div className="small muted">
              <strong>
                {m.name || (m.from === "team" ? "Support" : "Seller")}
              </strong>
              {m.internal ? " · internal note (seller can't see)" : ""} ·{" "}
              {when(m.at)}
            </div>
            {m.text && (
              <div style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>
                {m.text}
              </div>
            )}
            {(m.files || []).length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 4,
                }}
              >
                {m.files.map((f) => (
                  <button
                    key={f._id}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => open(f)}
                    title="Open"
                  >
                    📎 {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

// Reply box (+ internal note option for the team).
export function ReplyBox({ onSend, team = false, statuses = [], disabled }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() && !files.length)
      return toast("Write a reply or add a screenshot", "error");
    setBusy(true);
    try {
      await onSend({
        text: text.trim(),
        files: await filesPayload(files),
        ...(team ? { internal, status: status || undefined } : {}),
      });
      setText("");
      setFiles([]);
      setStatus("");
      setInternal(false);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <div
      className={`card ${internal ? "ticket-internal-box" : ""}`}
      style={{ marginTop: 12 }}
    >
      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          internal
            ? "Internal note — only your team sees this"
            : team
              ? "Reply to the seller…"
              : "Write your reply…"
        }
        disabled={disabled}
        style={{ width: "100%" }}
      />
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          marginTop: 8,
        }}
      >
        <FilePicker files={files} setFiles={setFiles} />
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {team && (
            <>
              <label className="check small">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                />{" "}
                Internal note
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                title="Change the status with this reply"
              >
                <option value="">Status: keep</option>
                {statuses.map(([k, l]) => (
                  <option key={k} value={k}>
                    → {l}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || disabled}
            onClick={send}
          >
            {busy ? "Sending…" : internal ? "Add note" : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}
