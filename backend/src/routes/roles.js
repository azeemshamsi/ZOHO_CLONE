// Custom roles: pick an access level for each module. Mounted at /api/roles (settings permission).
const router = require("express").Router();
const Joi = require("joi");
const Role = require("../models/Role");
const Membership = require("../models/Membership");
const { ALL_KEYS, MODULES, FEATURES, ROLES, LOCKED, forgetOverrides } = require("../utils/roles");
const { ah, validate, HttpError } = require("../utils/http");
const audit = require("../utils/audit");
const roleAudit = (req, action, r) => {
  audit.log(req, action, { target: r.name || String(r._id), meta: { roleId: String(r._id), perms: r.perms } });
  audit.alert(req.org, `Role ${action.replace("role_", "")}: ${r.name || r._id}`, `${req.user.name} <${req.user.email}> ${action.replace("role_", "")} the role "${r.name || r._id}".${r.perms ? `\nPermissions: ${Object.entries(r.perms).filter(([, v]) => v !== "none").map(([k, v]) => `${k}=${v}`).join(", ") || "none"}` : ""}`, `rolechg:${r._id}`);
};

const schema = Joi.object({
  name: Joi.string().trim().min(2).max(60).required().label("Role name"),
  desc: Joi.string().allow("").max(200),
  perms: Joi.object(Object.fromEntries(ALL_KEYS.map((k) => [k, Joi.string().valid("none", "view", "full", "")]))).required(),
  home: Joi.string().allow("").max(100),
});

router.get("/modules", (req, res) => res.send(MODULES.map(([key, label, desc]) => ({ key, label, desc, features: (FEATURES[key] || []).map(([f, l]) => ({ key: `${key}.${f}`, label: l })) }))));
// Page settings equal to their module's are dropped (they follow the module).
const tidy = (perms) => Object.fromEntries(Object.entries(perms).filter(([k, v]) => v && !(k.includes(".") && v === perms[k.split(".")[0]])));

// Built-in roles (Sales Staff, Order Taker…): a company can change or delete them; Admin can't be changed.
const builtinKey = (req) => {
  const k = req.params.key;
  if (!ROLES[k] || ROLES[k].hidden) throw new HttpError(404, "Role not found");
  if (LOCKED.includes(k)) throw new HttpError(400, "The Admin role can't be changed or deleted");
  return k;
};
async function saveBuiltin(req, key, fields) {
  const r = (await Role.find({ organization: req.org }).lean()).find((x) => x.builtin === key);
  if (r) return Role.findOneAndUpdate({ _id: r._id, organization: req.org }, fields, { new: true });
  return Role.create({ name: ROLES[key].label, ...fields, organization: req.org, builtin: key });
}
const usersWith = async (req, key) => (await Membership.find({ organization: req.org }, { role: 1, extraRoles: 1 }).lean()).filter((m) => m.role === key || (m.extraRoles || []).includes(key)).length;
router.put(
  "/builtin/:key",
  ah(async (req, res) => {
    const key = builtinKey(req);
    const d = validate(schema, req.body);
    d.perms = tidy(d.perms);
    const r = await saveBuiltin(req, key, { ...d, deleted: false });
    forgetOverrides(req.org);
    roleAudit(req, "role_updated", r);
    res.send(r);
  })
);
router.delete(
  "/builtin/:key",
  ah(async (req, res) => {
    const key = builtinKey(req);
    const n = await usersWith(req, key);
    if (n) throw new HttpError(400, `${n} user${n === 1 ? " has" : "s have"} this role. Give them another role first.`);
    const r = await saveBuiltin(req, key, { deleted: true, name: ROLES[key].label, desc: "", home: "", perms: {} });
    forgetOverrides(req.org);
    roleAudit(req, "role_deleted", { _id: r._id, name: ROLES[key].label });
    res.send({ ok: true });
  })
);
// Back to OrdexaGo's original (also brings a deleted built-in role back).
router.post(
  "/builtin/:key/reset",
  ah(async (req, res) => {
    const key = builtinKey(req);
    const r = (await Role.find({ organization: req.org }).lean()).find((x) => x.builtin === key);
    if (r) await Role.deleteOne({ _id: r._id, organization: req.org });
    forgetOverrides(req.org);
    roleAudit(req, "role_updated", { _id: key, name: `${ROLES[key].label} (reset to default)` });
    res.send({ ok: true });
  })
);
router.get(
  "/builtin/deleted",
  ah(async (req, res) => {
    const list = (await Role.find({ organization: req.org }).lean()).filter((r) => r.builtin && r.deleted);
    res.send(list.filter((r) => ROLES[r.builtin]).map((r) => ({ key: r.builtin, label: ROLES[r.builtin].label })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    d.perms = tidy(d.perms);
    if ((await Role.find({ organization: req.org, name: d.name }).lean()).some((r) => !r.builtin)) throw new HttpError(409, "A role with this name exists");
    const r = await Role.create({ ...d, organization: req.org });
    roleAudit(req, "role_created", r);
    res.status(201).send(r);
  })
);
router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    d.perms = tidy(d.perms);
    const r = await Role.findOneAndUpdate({ _id: req.params.id, organization: req.org }, d, { new: true });
    if (!r) throw new HttpError(404, "Role not found");
    roleAudit(req, "role_updated", r);
    res.send(r);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const key = `custom:${req.params.id}`;
    const n = (await Membership.find({ organization: req.org }, { role: 1, extraRoles: 1 }).lean()).filter((m) => m.role === key || (m.extraRoles || []).includes(key)).length;
    if (n) throw new HttpError(400, `${n} user${n === 1 ? " has" : "s have"} this role. Give them another role first.`);
    const gone = await Role.findOneAndDelete({ _id: req.params.id, organization: req.org });
    if (gone) roleAudit(req, "role_deleted", { _id: gone._id, name: gone.name });
    res.send({ ok: true });
  })
);
module.exports = router;
