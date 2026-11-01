/**
 * Report branch filter. While a report request runs with ?branch=<id|head>, every query on a
 * model that has a `branch` field only sees that branch's documents ("head" = no branch).
 * Must be required before any model is compiled.
 */
const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

const store = new AsyncLocalStorage();

mongoose.plugin((schema) => {
  if (!schema.path("branch")) return;
  schema.pre(["find", "findOne", "countDocuments"], function () {
    const s = store.getStore();
    if (!s || !s.branch) return;
    if (this.getFilter().branch !== undefined) return;
    this.where({ branch: s.branch === "head" ? null : s.branch });
  });
});

// Express middleware for report routes.
const scopeByBranch = (req, res, next) => {
  const b = req.query.branch;
  if (!b) return next();
  if (b !== "head" && !mongoose.isValidObjectId(b)) return res.status(400).send({ message: "Invalid branch" });
  store.run({ branch: b }, next);
};

module.exports = { scopeByBranch, store };
