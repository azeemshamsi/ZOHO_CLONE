/**
 * The team's ticket desk (Store → Tickets): sellers' support tickets — list by status, answer, add internal
 * notes, assign, change status / priority. Mounted at /api/tickets with the "tickets" permission.
 */
const router = require("express").Router();
const Joi = require("joi");
const SupportTicket = require("../models/SupportTicket");
const ShopifyStore = require("../models/ShopifyStore");
const Membership = require("../models/Membership");
const { ah, validate, HttpError } = require("../utils/http");
const T = require("../utils/tickets");

// Tickets live with the store's company (shared store: the company that owns it).
router.use(
  ah(async (req, res, next) => {
    if (await ShopifyStore.exists({ organization: req.org, shop: { $nin: ["", null] } })) req.storeOrg = req.org;
    else {
      const shared = await ShopifyStore.findOne({ sharedWith: req.org, connected: true }, { organization: 1 }).lean();
      req.storeOrg = shared ? shared.organization : req.org;
    }
    next();
  })
);

const teamView = (t) => ({
  ...t,
  ticketNo: T.ticketNo(t),
  statusLabel: T.LABEL[t.status],
  categoryLabel: T.CAT[t.category] || t.category,
});

router.get("/options", (req, res) => res.send({ categories: T.CATEGORIES, statuses: T.STATUSES, priorities: T.PRIORITIES }));

// People who can handle tickets (for "assign to").
router.get(
  "/staff",
  ah(async (req, res) => {
    const { resolveRole } = require("../utils/roles");
    const ms = await Membership.find({ organization: req.org }).populate("user", "name email").lean();
    const out = [];
    for (const m of ms) {
      if (!m.user || m.role === "seller") continue;
      const r = await resolveRole(m.role, req.org, m.extraRoles).catch(() => null);
      if (m.role === "admin" || ["full", "view"].includes(r?.perms?.tickets)) out.push({ _id: m.user._id, name: m.user.name || m.user.email });
    }
    res.send(out.sort((a, b) => a.name.localeCompare(b.name)));
  })
);

// ?status=open|in_progress|waiting|resolved|closed|active (default: not closed) & seller & category & assignee
// (me | none | <user id>) & priority & q (number, subject, seller, order).
router.get(
  "/",
  ah(async (req, res) => {
    const all = await SupportTicket.find({ organization: req.storeOrg }, { messages: 0 }).sort({ lastActivityAt: -1 }).lean();
    const counts = Object.fromEntries([...T.STATUSES.map(([k]) => [k, 0]), ["all", all.length], ["unassigned", 0], ["mine", 0]]);
    for (const t of all) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (!["resolved", "closed"].includes(t.status)) {
        if (!t.assignee?.user) counts.unassigned++;
        if (String(t.assignee?.user || "") === String(req.user._id)) counts.mine++;
      }
    }
    const st = req.query.status || "active";
    const q = String(req.query.q || "").trim().toLowerCase();
    const list = all.filter((t) => {
      if (st === "active" ? ["resolved", "closed"].includes(t.status) : st !== "all" && st !== "unassigned" && st !== "mine" && t.status !== st) return false;
      if (st === "unassigned" && (t.assignee?.user || ["resolved", "closed"].includes(t.status))) return false;
      if (st === "mine" && (String(t.assignee?.user || "") !== String(req.user._id) || ["resolved", "closed"].includes(t.status))) return false;
      if (req.query.seller && String(t.seller) !== req.query.seller) return false;
      if (req.query.category && t.category !== req.query.category) return false;
      if (req.query.priority && t.priority !== req.query.priority) return false;
      if (req.query.assignee === "none" ? t.assignee?.user : req.query.assignee && String(t.assignee?.user || "") !== (req.query.assignee === "me" ? String(req.user._id) : req.query.assignee)) return false;
      if (q && ![T.ticketNo(t), String(t.number), t.subject, t.sellerName, t.orderName].some((x) => String(x || "").toLowerCase().includes(q))) return false;
      return true;
    });
    counts.active = all.filter((t) => !["resolved", "closed"].includes(t.status)).length;
    res.send({ rows: list.slice(0, 500).map(teamView), counts, total: list.length });
  })
);

const load = async (req) => {
  const t = await SupportTicket.findOne({ _id: req.params.id, organization: req.storeOrg });
  if (!t) throw new HttpError(404, "Ticket not found");
  return t;
};

router.get(
  "/:id",
  ah(async (req, res) => {
    const t = await load(req);
    if (t.teamUnread) {
      t.teamUnread = 0;
      await t.save();
    }
    res.send(teamView(t.toObject()));
  })
);

// Reply to the seller, or an internal note (internal: true). status: optionally change it in the same step.
router.post(
  "/:id/reply",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        text: Joi.string().trim().allow("").max(5000).default(""),
        internal: Joi.boolean().default(false),
        status: Joi.string().valid(...T.STATUSES.map((s) => s[0])).allow("", null),
        files: Joi.array().items(Joi.object({ name: Joi.string().max(200).required(), type: Joi.string().allow("").default(""), data: Joi.string().required() })).max(5).default([]),
      }),
      req.body
    );
    if (!d.text && !d.files.length) throw new HttpError(400, "Write a reply or add a file");
    const t = await load(req);
    const files = await T.saveFiles(t.organization, d.files);
    t.messages.push({ from: "team", user: req.user._id, name: req.user.name || "Support", text: d.text, files, internal: d.internal });
    if (!d.internal) {
      t.sellerUnread = (t.sellerUnread || 0) + 1;
      if (!t.firstResponseAt) t.firstResponseAt = new Date();
      t.lastFrom = "team";
      if (!d.status && t.status === "open") t.status = "in_progress";
    }
    if (!t.assignee?.user) t.assignee = { user: req.user._id, name: req.user.name || "" }; // whoever answers first takes it
    if (d.status && d.status !== t.status) setStatus(t, d.status, req.user);
    t.lastActivityAt = new Date();
    await t.save();
    if (!d.internal) await T.notifySeller(t, t.status === "resolved" ? "We've resolved the issue" : "Our team replied");
    res.send(teamView(t.toObject()));
  })
);

function setStatus(t, status, user) {
  const was = t.status;
  t.status = status;
  if (status === "resolved") t.resolvedAt = new Date();
  if (status === "closed") t.closedAt = new Date();
  t.messages.push({ from: "system", user: user._id, name: user.name || "", text: `Status: ${T.LABEL[was]} → ${T.LABEL[status]}` });
}

// Status, assignee, priority, category.
router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        status: Joi.string().valid(...T.STATUSES.map((s) => s[0])),
        assignee: Joi.string().hex().length(24).allow("", null),
        priority: Joi.string().valid(...T.PRIORITIES),
        category: Joi.string().valid(...T.CATEGORIES.map((c) => c[0])),
      }),
      req.body
    );
    const t = await load(req);
    if (d.status && d.status !== t.status) {
      setStatus(t, d.status, req.user);
      if (d.status === "resolved") t.sellerUnread = (t.sellerUnread || 0) + 1;
    }
    if (d.assignee !== undefined) {
      if (!d.assignee) t.assignee = { user: null, name: "" };
      else {
        const m = await Membership.findOne({ organization: req.org, user: d.assignee }).populate("user", "name email").lean();
        if (!m?.user) throw new HttpError(400, "That person isn't a user of this company");
        t.assignee = { user: m.user._id, name: m.user.name || m.user.email };
        t.messages.push({ from: "system", user: req.user._id, name: req.user.name || "", text: `Assigned to ${t.assignee.name}`, internal: true });
      }
    }
    if (d.priority) t.priority = d.priority;
    if (d.category) t.category = d.category;
    t.lastActivityAt = new Date();
    await t.save();
    if (d.status === "resolved") await T.notifySeller(t, "We've resolved the issue");
    res.send(teamView(t.toObject()));
  })
);

router.get(
  "/:id/files/:fid",
  ah(async (req, res) => {
    const t = await load(req);
    T.streamFile(t, req.params.fid, res);
  })
);

module.exports = router;
