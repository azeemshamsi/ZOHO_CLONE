import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { Modal, Field, SearchBox, Spinner, toast, useDebounced } from "../components/ui";
import Icon from "../components/Icon";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";

/**
 * Inbox: one place for WhatsApp, Instagram and Messenger DMs, Facebook / Instagram post comments and email.
 * Left: conversations (channel chips, unread / mine / unassigned, search). Middle: the thread and the reply box.
 * Right: the contact and their store orders. New messages are picked up every 10 seconds.
 */
export const CHANNELS = {
  whatsapp: { label: "WhatsApp", short: "WA", color: "#128c7e" },
  instagram: { label: "Instagram", short: "IG", color: "#c13584" },
  messenger: { label: "Messenger", short: "FB", color: "#0866ff" },
  fb_comment: { label: "Facebook comments", short: "FB·c", color: "#4267b2" },
  ig_comment: { label: "Instagram comments", short: "IG·c", color: "#e1306c" },
  email: { label: "Email", short: "@", color: "#c5221f" },
};
const STATUS_LABEL = { new: "New", packed: "Packed", ready_to_ship: "Ready to ship", shipped: "Shipped", delivered: "Delivered", rto: "RTO", return_created: "Return", returned: "Returned", cancelled: "Cancelled" };
const EMOJI = ["🙂", "😊", "😀", "🙏", "👍", "👌", "❤️", "🎉", "✅", "📦", "🚚", "⏳", "😔", "🙌", "👋", "💯", "⭐", "🔥", "😅", "🤝", "📞", "💬", "🛒", "🎁"];
const TICKS = { queued: "🕓", sent: "✓", delivered: "✓✓", read: "✓✓", failed: "!", received: "" };

const timeAgo = (d) => {
  if (!d) return "";
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};
const fullTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const nameOf = (c) => c?.contact?.name || c?.contact?.handle || c?.contact?.phone || c?.contact?.email || "Unknown";
const readFile = (f) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(f);
  });

function ChannelBadge({ channel }) {
  const c = CHANNELS[channel] || { short: "?", color: "#888" };
  return (
    <span className="ch-badge" style={{ background: c.color }} title={c.label}>
      {c.short}
    </span>
  );
}

// Media needs the session header, so it's fetched and shown as a blob URL.
function AuthMedia({ m }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    let alive = true;
    if (m.url && m.url.startsWith("/api/")) {
      api
        .get(m.url.replace(/^\/api/, ""), { responseType: "blob" })
        .then((r) => {
          u = URL.createObjectURL(r.data);
          if (alive) setUrl(u);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [m.url]);
  if (m.removed || (!m.url && !m.fileId)) return <div className="muted small">[{m.name || "file"} — {m.removed ? "removed after the retention period" : m.size > 16e6 ? "too large to keep" : "not available"}]</div>;
  if (!url) return <div className="muted small">Loading {m.name || "file"}…</div>;
  const mime = m.mime || "";
  if (mime.startsWith("image/")) return <a href={url} target="_blank" rel="noreferrer"><img className="msg-img" src={url} alt={m.name || "image"} /></a>;
  if (mime.startsWith("video/")) return <video className="msg-img" src={url} controls />;
  if (mime.startsWith("audio/")) return <audio src={url} controls />;
  return (
    <a className="msg-file" href={url} download={m.name || "file"}>
      <Icon name="clip" size={14} /> {m.name || "Download file"}
    </a>
  );
}

function Bubble({ m, conv, onReplyComment, onPrivate, onHide }) {
  const comment = conv.channel.endsWith("_comment");
  const cls = m.kind === "note" ? "msg note" : `msg ${m.direction === "in" ? "in" : "out"}`;
  return (
    <div className={cls}>
      {m.kind === "note" && <div className="msg-by">Internal note · {m.byName}</div>}
      {m.direction === "out" && m.kind !== "note" && (m.byName || m.auto) && <div className="msg-by">{m.byName || m.auto}{m.meta?.private ? " · private reply" : ""}</div>}
      {m.kind === "template" && <div className="msg-by">Template {m.meta?.template?.name}</div>}
      {m.kind === "email" && m.meta?.email?.subject && <div className="msg-by">{m.direction === "in" ? `From ${m.meta.email.from}` : `To ${m.meta.email.to || ""}`}</div>}
      {(m.media || []).map((x, i) => (
        <AuthMedia key={i} m={x} />
      ))}
      {m.text && <div className="msg-text">{m.text}</div>}
      {m.meta?.button && <div className="msg-by">Tapped “{m.meta.button.text || m.meta.button.payload}”</div>}
      {m.meta?.hidden && <div className="msg-by text-amber">Hidden on {conv.channel === "ig_comment" ? "Instagram" : "Facebook"}</div>}
      {m.meta?.deleted && <div className="msg-by text-danger">Deleted by the author</div>}
      <div className="msg-meta">
        {fullTime(m.at)} {m.direction === "out" && m.kind !== "note" && <span className={m.status === "read" ? "tick-read" : m.status === "failed" ? "text-danger" : ""}>{TICKS[m.status]} {m.status === "failed" ? "Failed" : ""}</span>}
      </div>
      {m.status === "failed" && m.error && <div className="msg-err">{m.error}</div>}
      {comment && m.direction === "in" && m.externalId && (
        <div className="msg-actions">
          <button className="link-btn" onClick={() => onReplyComment(m)}>Reply</button>
          <button className="link-btn" onClick={() => onPrivate(m)}>Private reply</button>
          <button className="link-btn" onClick={() => onHide(m)}>{m.meta?.hidden ? "Unhide" : "Hide"}</button>
        </div>
      )}
    </div>
  );
}

function TemplatePicker({ open, onClose, onSend }) {
  const [list, setList] = useState(null);
  const [pick, setPick] = useState(null);
  const [vals, setVals] = useState([]);
  const [header, setHeader] = useState("");
  useEffect(() => {
    if (open) api.get("/inbox/templates").then((r) => setList(r.data)).catch(() => setList([]));
  }, [open]);
  const body = pick?.components?.find((c) => c.type === "BODY")?.text || "";
  const choose = (t) => {
    setPick(t);
    setVals(Array.from({ length: t.bodyParams || 0 }, () => ""));
    setHeader("");
  };
  const preview = body.replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] || m);
  return (
    <Modal
      open={open}
      title="Send a WhatsApp template"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!pick || vals.some((v) => !v.trim()) || (pick.headerParams > 0 && !header)} onClick={() => onSend({ name: pick.name, language: pick.language, body: vals, header: pick.headerParams ? header : "" }, preview)}>
            Send template
          </button>
        </>
      }
    >
      {!list ? (
        <Spinner />
      ) : !list.length ? (
        <p className="muted">No approved templates yet. Create them in WhatsApp Manager, then press “Sync templates” on Marketing → Automations.</p>
      ) : (
        <div className="grid-2">
          <div className="tpl-list">
            {list.map((t) => (
              <button key={t._id} className={`tpl-item ${pick?._id === t._id ? "on" : ""}`} onClick={() => choose(t)}>
                <strong>{t.name}</strong> <span className="muted small">{t.language} · {t.category?.toLowerCase()}</span>
              </button>
            ))}
          </div>
          <div>
            {pick ? (
              <>
                <div className="tpl-preview">{preview}</div>
                {pick.headerParams > 0 && (
                  <Field label="Header {{1}}">
                    <input value={header} onChange={(e) => setHeader(e.target.value)} />
                  </Field>
                )}
                {vals.map((v, i) => (
                  <Field key={i} label={`{{${i + 1}}}`}>
                    <input value={v} onChange={(e) => setVals(vals.map((x, j) => (j === i ? e.target.value : x)))} />
                  </Field>
                ))}
              </>
            ) : (
              <p className="muted">Choose a template.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function OrdersPanel({ conv, onAssign, onStatus, onTags, users }) {
  const [d, setD] = useState(null);
  const [tag, setTag] = useState("");
  useEffect(() => {
    setD(null);
    api.get(`/inbox/conversations/${conv._id}/orders`).then((r) => setD(r.data)).catch(() => setD({ orders: [], totals: {} }));
  }, [conv._id]);
  const ct = conv.contact || {};
  return (
    <div className="inbox-side-body">
      <div className="side-contact">
        {ct.avatar ? <img className="side-avatar" src={ct.avatar} alt="" referrerPolicy="no-referrer" /> : <div className="side-avatar ph">{nameOf(conv).slice(0, 1).toUpperCase()}</div>}
        <div>
          <strong>{nameOf(conv)}</strong>
          <div className="muted small">{[ct.phone && `+${ct.phone}`, ct.email, ct.handle].filter(Boolean).join(" · ")}</div>
          <div className="small"><ChannelBadge channel={conv.channel} /> {CHANNELS[conv.channel]?.label}</div>
        </div>
      </div>
      <Field label="Assigned to">
        <select value={conv.assignedTo || ""} onChange={(e) => onAssign(e.target.value)}>
          <option value="">Nobody</option>
          {users.map((u) => (
            <option key={u._id} value={u._id}>{u.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Status">
        <select value={conv.status} onChange={(e) => onStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="closed">Closed</option>
        </select>
      </Field>
      <div className="label-sm">Tags</div>
      <div>
        {(conv.tags || []).map((t) => (
          <span key={t} className="chip">
            {t}{" "}
            <button className="link-btn" onClick={() => onTags((conv.tags || []).filter((x) => x !== t))} aria-label={`Remove ${t}`}>×</button>
          </span>
        ))}
        <form
          className="inline-add"
          style={{ marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim()) onTags([...(conv.tags || []), tag.trim()]);
            setTag("");
          }}
        >
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add a tag" />
        </form>
      </div>
      {conv.post?.id && (
        <div className="side-post">
          <div className="label-sm">Post</div>
          {conv.post.thumbnail && <img className="post-thumb" src={conv.post.thumbnail} alt="" referrerPolicy="no-referrer" />}
          {conv.post.caption && <p className="small clamp">{conv.post.caption}</p>}
          {conv.post.permalink && <a href={conv.post.permalink} target="_blank" rel="noreferrer" className="small">Open the post ↗</a>}
        </div>
      )}
      <div className="label-sm" style={{ marginTop: 14 }}>Orders</div>
      {!d ? (
        <Spinner />
      ) : !d.orders.length ? (
        <p className="muted small">{conv.channel === "whatsapp" || conv.contact?.email ? "No store orders for this number / email." : "No phone or email to match orders with."}</p>
      ) : (
        <>
          <p className="small muted">{d.totals.orders} order{d.totals.orders > 1 ? "s" : ""} · {money(d.totals.spend)}{d.totals.rto ? ` · ${d.totals.rto} RTO` : ""}</p>
          {d.orders.map((o) => (
            <div key={o._id} className="side-order">
              <div className="side-order-head">
                {d.canSeeOrders ? <Link to={`/shopify-orders?tab=all&q=${encodeURIComponent(o.name)}&open=${o._id}`}>{o.name}</Link> : <strong>{o.name}</strong>}
                <span className={`chip ${o.status === "rto" || o.status === "cancelled" ? "chip-red" : o.status === "delivered" ? "" : "chip-amber"}`}>{STATUS_LABEL[o.status] || o.status}</span>
              </div>
              <div className="small muted">
                {new Date(o.orderDate).toLocaleDateString("en-IN")} · {money(o.total)} · {o.paymentMode === "cod" ? "COD" : "Prepaid"}
              </div>
              {o.shipment?.awb && (
                <div className="small">
                  {o.shipment.courierName} {o.shipment.trackingUrl ? <a href={o.shipment.trackingUrl} target="_blank" rel="noreferrer">{o.shipment.awb} ↗</a> : o.shipment.awb}
                </div>
              )}
              {o.codConfirm?.state && <div className={`small ${o.codConfirm.state === "confirmed" ? "text-good" : "text-danger"}`}>{o.codConfirm.state === "confirmed" ? "COD confirmed on WhatsApp" : "Asked to cancel on WhatsApp"}</div>}
              {(o.lines || []).slice(0, 3).map((l, i) => (
                <div key={i} className="small muted ellipsis">{l.quantity}× {l.title}</div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Thread({ id, onChanged, users, onBack }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [qr, setQr] = useState(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [target, setTarget] = useState(null); // comment being replied to: { m, private }
  const [aiBusy, setAiBusy] = useState(false);
  const [side, setSide] = useState(false);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const lastCount = useRef(0);
  const writable = can(user, "inbox", "full");

  const load = () =>
    api.get(`/inbox/conversations/${id}`).then((r) => {
      setData(r.data);
      return r.data;
    });
  useEffect(() => {
    setData(null);
    setText("");
    setFile(null);
    setTarget(null);
    setNote(false);
    lastCount.current = 0;
    load().catch((e) => toast(errMsg(e), "error"));
    const t = setInterval(() => {
      load().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [id]);
  useEffect(() => {
    const n = data?.messages?.length || 0;
    if (n !== lastCount.current) endRef.current?.scrollIntoView({ block: "end" });
    lastCount.current = n;
  }, [data]);
  useEffect(() => {
    api.get("/inbox/quick-replies").then((r) => setQr(r.data)).catch(() => setQr([]));
  }, []);

  if (!data) return <div className="inbox-thread"><Spinner /></div>;
  const conv = data.conversation;
  const isComment = conv.channel.endsWith("_comment");
  const needsTemplate = conv.channel === "whatsapp" && !conv.inWindow;
  const outside = ["messenger", "instagram"].includes(conv.channel) && !conv.inWindow;

  const update = async (body) => {
    try {
      await api.put(`/inbox/conversations/${id}`, body);
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const send = async (extra = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const body = { text, note, ...extra };
      if (file && !note) body.file = { name: file.name, type: file.type, data: await readFile(file) };
      if (target && !note) {
        body.commentId = target.m.externalId;
        body.privateReply = target.private;
      }
      await api.post(`/inbox/conversations/${id}/messages`, body);
      setText("");
      setFile(null);
      setTarget(null);
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
      await load().catch(() => {});
    }
    setBusy(false);
  };
  const aiDraft = async () => {
    setAiBusy(true);
    try {
      const r = await api.post(`/inbox/conversations/${id}/ai-draft`);
      setText(r.data.text);
      setNote(false);
      toast("AI draft ready — check it, edit if needed, then send");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setAiBusy(false);
  };
  const hide = async (m) => {
    try {
      await api.post(`/inbox/conversations/${id}/hide`, { messageId: m._id, hide: !m.meta?.hidden });
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
    if (e.key === "/" && !text && qr?.length) setQrOpen(true);
  };
  const qrMatches = text.startsWith("/") ? (qr || []).filter((q) => q.shortcut && `/${q.shortcut}`.startsWith(text.split(/\s/)[0])) : [];

  return (
    <div className={`inbox-main ${side ? "show-side" : ""}`}>
      <div className="inbox-thread">
        <div className="thread-head">
          <button className="icon-btn inbox-back" onClick={onBack} aria-label="Back">←</button>
          <ChannelBadge channel={conv.channel} />
          <div className="thread-title">
            <strong>{nameOf(conv)}</strong>
            <div className="muted small">
              {conv.subject || (conv.channel === "whatsapp" && conv.contact?.phone ? `+${conv.contact.phone}` : CHANNELS[conv.channel]?.label)}
              {["whatsapp", "messenger", "instagram"].includes(conv.channel) && (conv.inWindow ? ` · replies open until ${fullTime(conv.windowEndsAt)}` : " · 24-hour window closed")}
            </div>
          </div>
          {writable && (
            <button className="btn btn-sm" onClick={() => update({ status: conv.status === "closed" ? "open" : "closed" })}>
              {conv.status === "closed" ? "Reopen" : "Close"}
            </button>
          )}
          <button className="btn btn-sm inbox-info-btn" onClick={() => setSide(!side)}>{side ? "Chat" : "Orders"}</button>
        </div>
        <div className="thread-body">
          {data.messages.map((m) => (
            <Bubble key={m._id} m={m} conv={conv} onReplyComment={(x) => setTarget({ m: x, private: false })} onPrivate={(x) => setTarget({ m: x, private: true })} onHide={hide} />
          ))}
          {!data.messages.length && <p className="muted center">No messages yet.{conv.channel === "whatsapp" ? " Start with an approved template." : ""}</p>}
          <div ref={endRef} />
        </div>
        {writable && (
          <div className="reply-box">
            {conv.aiDraft?.text && !text && (
              <div className="ai-draft">
                <div className="label-sm">AI draft (needs your approval)</div>
                <div className="msg-text">{conv.aiDraft.text}</div>
                <div className="row-actions">
                  <button className="btn btn-sm" onClick={() => setText(conv.aiDraft.text)}>Edit</button>
                  <button className="btn btn-sm btn-primary" disabled={busy || needsTemplate} onClick={() => send({ text: conv.aiDraft.text, fromDraft: true })}>Approve & send</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => api.delete(`/inbox/conversations/${id}/ai-draft`).then(load)}>Discard</button>
                </div>
              </div>
            )}
            {needsTemplate && !note && (
              <div className="alert alert-warn" style={{ marginTop: 0 }}>
                More than 24 hours since their last message: WhatsApp allows only an approved template now.{" "}
                <button className="link-btn" onClick={() => setTplOpen(true)}>Choose a template</button> · or write an internal note.
              </div>
            )}
            {outside && !note && <div className="alert alert-warn" style={{ marginTop: 0 }}>The 24-hour window has closed — Meta may refuse the reply (the Human Agent tag allows 7 days only if your app is approved for it).</div>}
            {isComment && !note && (
              <div className="small muted" style={{ marginBottom: 6 }}>
                {target ? (
                  <>
                    {target.private ? "Private message to" : "Public reply to"} “{(target.m.text || "").slice(0, 60)}” <button className="link-btn" onClick={() => setTarget(null)}>cancel</button>
                  </>
                ) : (
                  "Replies go under the latest comment, in public. Use Reply / Private reply on a comment to choose."
                )}
              </div>
            )}
            {file && (
              <div className="chip">
                <Icon name="clip" size={12} /> {file.name} <button className="link-btn" onClick={() => setFile(null)}>×</button>
              </div>
            )}
            {qrMatches.length > 0 && (
              <div className="qr-pop">
                {qrMatches.map((q) => (
                  <button key={q._id} onClick={() => setText(q.text)}>
                    <strong>/{q.shortcut}</strong> {q.title}
                  </button>
                ))}
              </div>
            )}
            <textarea
              rows={3}
              className={note ? "note-input" : ""}
              value={text}
              disabled={needsTemplate && !note}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder={note ? "Internal note — only your team sees it" : conv.channel === "email" ? "Write a reply (the original is quoted below it)" : "Type a reply… (Ctrl+Enter sends, / for quick replies)"}
            />
            <div className="reply-tools">
              <label className="switch-row small" title="Internal note">
                <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} /> Note
              </label>
              <div className="menu-wrap">
                <button className="icon-btn" onClick={() => setEmoji(!emoji)} aria-label="Emoji">🙂</button>
                {emoji && (
                  <div className="dropdown emoji-pop" onMouseLeave={() => setEmoji(false)}>
                    {EMOJI.map((e) => (
                      <button key={e} onClick={() => setText((t) => t + e)}>{e}</button>
                    ))}
                  </div>
                )}
              </div>
              {!isComment && !note && (
                <>
                  <button className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Attach" title="Attach an image or document">
                    <Icon name="clip" size={16} />
                  </button>
                  <input ref={fileRef} type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,video/mp4" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                </>
              )}
              <div className="menu-wrap">
                <button className="btn btn-sm" onClick={() => setQrOpen(!qrOpen)}>Quick replies</button>
                {qrOpen && (
                  <div className="dropdown qr-menu" onMouseLeave={() => setQrOpen(false)}>
                    {!qr?.length && <div className="muted small" style={{ padding: 8 }}>None yet — add them on Marketing → Auto-replies.</div>}
                    {(qr || []).map((q) => (
                      <button
                        key={q._id}
                        onClick={() => {
                          setText(q.text);
                          setQrOpen(false);
                        }}
                      >
                        {q.title}
                        {q.shortcut ? <span className="muted"> /{q.shortcut}</span> : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {conv.channel === "whatsapp" && <button className="btn btn-sm" onClick={() => setTplOpen(true)}>Template</button>}
              <button className="btn btn-sm" disabled={aiBusy} onClick={aiDraft}>{aiBusy ? "Drafting…" : "AI draft"}</button>
              <span className="spacer" />
              <button className="btn btn-primary btn-sm" disabled={busy || (!text.trim() && !file) || (needsTemplate && !note)} onClick={() => send()}>
                {busy ? "Sending…" : note ? "Add note" : target?.private ? "Send privately" : "Send"}
              </button>
            </div>
          </div>
        )}
        <TemplatePicker
          open={tplOpen}
          onClose={() => setTplOpen(false)}
          onSend={(tpl, preview) => {
            setTplOpen(false);
            send({ template: tpl, text: preview, note: false });
          }}
        />
      </div>
      <aside className="inbox-side">
        <OrdersPanel conv={conv} users={users} onAssign={(v) => update({ assignedTo: v })} onStatus={(v) => update({ status: v })} onTags={(tags) => update({ tags })} />
      </aside>
    </div>
  );
}

function StartChat({ open, onClose, onStarted }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal
      open={open}
      title="New WhatsApp chat"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => api.post("/inbox/start", { phone, name }).then((r) => onStarted(r.data._id)).catch((e) => toast(errMsg(e), "error"))}>
            Open chat
          </button>
        </>
      }
    >
      <p className="muted small">The first message to someone who hasn't written to you in the last 24 hours must be an approved template.</p>
      <Field label="WhatsApp number" hint="10-digit Indian numbers get +91">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}

export default function Inbox() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const sel = params.get("c") || "";
  const [channel, setChannel] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [list, setList] = useState(null);
  const [summary, setSummary] = useState(null);
  const [users, setUsers] = useState([]);
  const [startOpen, setStartOpen] = useState(false);

  const load = () =>
    Promise.all([api.get("/inbox/conversations", { params: { channel, filter, status, q: dq } }), api.get("/inbox/summary")]).then(([a, b]) => {
      setList(a.data);
      setSummary(b.data);
    });
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
    const t = setInterval(() => {
      load().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [channel, filter, status, dq]);
  useEffect(() => {
    api.get("/inbox/users").then((r) => setUsers(r.data)).catch(() => {});
  }, []);
  const open = (id) => setParams(id ? { c: id } : {});
  const connected = useMemo(() => Object.entries(summary?.channels || {}).filter(([, v]) => v).map(([k]) => k), [summary]);

  if (summary && !connected.length && !list?.total)
    return (
      <div className="card center" style={{ maxWidth: 640, margin: "40px auto" }}>
        <Icon name="chat" size={32} />
        <h3>Your inbox is empty</h3>
        <p className="muted">Connect WhatsApp, Instagram, Facebook and Gmail to read and answer every customer message here, next to their orders.</p>
        {can(user, "marketing") ? <Link className="btn btn-primary" to="/marketing/integrations">Set up channels</Link> : <p className="muted small">Ask an admin to connect the channels (Marketing → Integrations).</p>}
      </div>
    );

  return (
    <div className={`inbox ${sel ? "has-sel" : ""}`}>
      <section className="inbox-list">
        <div className="inbox-list-head">
          <SearchBox value={q} onChange={setQ} placeholder="Search name, number, text" />
          {connected.includes("whatsapp") && can(user, "inbox", "full") && (
            <button className="btn btn-sm" onClick={() => setStartOpen(true)} title="New WhatsApp chat">
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        <div className="ch-chips">
          <button className={`chip-check ${!channel ? "on" : ""}`} onClick={() => setChannel("")}>All</button>
          {Object.entries(CHANNELS).map(([k, c]) => (
            <button key={k} className={`chip-check ${channel === k ? "on" : ""}`} onClick={() => setChannel(channel === k ? "" : k)}>
              {c.label.replace(" comments", " ·c")}
              {summary?.unread?.[k] ? <span className="tab-count red">{summary.unread[k]}</span> : null}
            </button>
          ))}
        </div>
        <div className="seg inbox-seg">
          {[["", "All"], ["unread", "Unread"], ["mine", "Mine"], ["unassigned", "Unassigned"]].map(([k, l]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
          ))}
          <select className="inline-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
            <option value="">Any status</option>
          </select>
        </div>
        <div className="conv-list">
          {!list ? (
            <Spinner />
          ) : !list.items.length ? (
            <p className="muted center small" style={{ padding: 20 }}>No conversations here.</p>
          ) : (
            list.items.map((c) => (
              <button key={c._id} className={`conv ${sel === c._id ? "on" : ""} ${c.unread ? "unread" : ""}`} onClick={() => open(c._id)}>
                <ChannelBadge channel={c.channel} />
                <div className="conv-main">
                  <div className="conv-top">
                    <span className="conv-name ellipsis">{nameOf(c)}</span>
                    <span className="muted small nowrap">{timeAgo(c.lastMessageAt)}</span>
                  </div>
                  <div className="conv-prev ellipsis">{c.subject ? <strong>{c.subject} · </strong> : null}{c.lastMessagePreview}</div>
                  {(c.tags?.length > 0 || c.assignedTo) && (
                    <div className="conv-tags">
                      {c.tags?.slice(0, 2).map((t) => <span key={t} className={`chip ${/cancel/i.test(t) ? "chip-red" : ""}`}>{t}</span>)}
                      {c.assignedTo && <span className="chip">{users.find((u) => u._id === c.assignedTo)?.name || "Assigned"}</span>}
                    </div>
                  )}
                </div>
                {c.unread > 0 && <span className="unread-dot">{c.unread}</span>}
              </button>
            ))
          )}
        </div>
      </section>
      {sel ? (
        <Thread key={sel} id={sel} users={users} onChanged={() => load().catch(() => {})} onBack={() => open("")} />
      ) : (
        <div className="inbox-empty muted">
          <Icon name="chat" size={28} />
          <p>Choose a conversation</p>
        </div>
      )}
      <StartChat
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onStarted={(id) => {
          setStartOpen(false);
          open(id);
          load().catch(() => {});
        }}
      />
    </div>
  );
}
