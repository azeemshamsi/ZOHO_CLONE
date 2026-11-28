/**
 * Blocks NoSQL operator injection: removes any key starting with "$" from the query string and JSON bodies before
 * the routes see them, so a value like ?status[$ne]=x or {"email": {"$gt": ""}} can never turn into a database
 * operator. OrdexaGo's own requests never send such keys.
 */
function strip(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 30 || Buffer.isBuffer(v)) return 0;
  let n = 0;
  if (Array.isArray(v)) {
    for (const x of v) n += strip(x, depth + 1);
    return n;
  }
  for (const k of Object.keys(v)) {
    if (k.startsWith("$")) {
      delete v[k];
      n++;
    } else n += strip(v[k], depth + 1);
  }
  return n;
}

function noOperators(req, res, next) {
  const n = strip(req.query) + (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? strip(req.body) : 0) + strip(req.params);
  if (n) {
    console.warn(`[security] removed ${n} "$" key(s) from ${req.method} ${(req.originalUrl || "").split("?")[0]} (${req.ip})`);
    try {
      require("./audit").log(req, "injection_blocked", { organization: null, user: null, email: "", target: (req.originalUrl || "").split("?")[0], meta: { keys: n } });
    } catch {}
  }
  next();
}

module.exports = { noOperators, strip };
