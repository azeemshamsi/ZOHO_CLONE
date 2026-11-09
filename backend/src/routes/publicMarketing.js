/**
 * Public pages: email unsubscribe (/api/unsubscribe/:token) and signed media links for Meta
 * (/api/public-media/:id?exp&sig — Instagram / Messenger fetch files we send from here).
 */
const router = require("express").Router();
const { readUnsubscribeToken, optOut } = require("../utils/marketing/optout");

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px;color:#222}.c{max-width:440px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 4px #0001}button{background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head><body><div class="c">${body}</div></body></html>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

router.get("/unsubscribe/:token", (req, res) => {
  const t = readUnsubscribeToken(req.params.token);
  if (!t) return res.status(400).send(page("Unsubscribe", "<h2>Link not valid</h2><p>This unsubscribe link is broken or incomplete.</p>"));
  res.send(page("Unsubscribe", `<h2>Unsubscribe</h2><p>Stop marketing emails to <b>${esc(t.email)}</b>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
});
router.post("/unsubscribe/:token", async (req, res) => {
  const t = readUnsubscribeToken(req.params.token);
  if (!t) return res.status(400).send(page("Unsubscribe", "<h2>Link not valid</h2>"));
  try {
    await optOut(t.org, "email", t.email, "unsubscribe_link");
    await require("../utils/audit").log(req, "email_unsubscribed", { organization: t.org, user: null, email: "", target: "unsubscribe" });
  } catch (e) {
    return res.status(500).send(page("Unsubscribe", "<h2>Something went wrong</h2><p>Please try again.</p>"));
  }
  res.send(page("Unsubscribed", `<h2>You're unsubscribed</h2><p>${esc(t.email)} won't get marketing emails from us any more.</p>`));
});

router.get("/public-media/:id", async (req, res) => {
  const { checkMediaSig } = require("../utils/marketing/inbox");
  if (!checkMediaSig(req.params.id, req.query.exp, req.query.sig)) return res.status(403).send("Link expired");
  const mongoose = require("mongoose");
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const f = await mongoose.connection.db.collection("inbox_media.files").findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
  if (!f) return res.sendStatus(404);
  res.set({ "Content-Type": f.metadata?.type || "application/octet-stream", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" });
  require("../utils/marketing/media").streamOf(f._id).on("error", () => res.end()).pipe(res);
});

module.exports = router;
