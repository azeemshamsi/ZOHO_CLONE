/**
 * Per-IP rate limits (in memory — one app process). Sign-in, password-reset and sign-up steps get tight limits
 * against password guessing and email flooding; the rest of the API a generous ceiling that normal use never
 * reaches. Requests from the server itself (127.0.0.1: health checks, the AI assistant's own lookups) are exempt.
 * The first refusal in each window is written to the security log.
 */
const buckets = new Map(); // name|key → { n, reset }

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function limiter({ name, windowMs, max, key = (req) => req.ip, message = "Too many requests — please wait a few minutes and try again." }) {
  return (req, res, next) => {
    const ip = req.ip || "";
    if (LOOPBACK.has(ip)) return next();
    const k = `${name}|${key(req)}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset <= now) {
      b = { n: 0, reset: now + windowMs };
      buckets.set(k, b);
    }
    b.n++;
    if (b.n <= max) return next();
    res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
    if (b.n === max + 1) {
      try {
        require("./audit").log(req, "rate_limited", { organization: null, user: null, email: "", target: (req.originalUrl || "").split("?")[0], meta: { limit: name, max, windowMinutes: Math.round(windowMs / 60000) } });
      } catch {}
      console.warn(`[security] rate limit "${name}" hit by ${ip} on ${req.method} ${(req.originalUrl || "").split("?")[0]}`);
    }
    return res.status(429).send({ message });
  };
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 5 * 60 * 1000);
sweep.unref();

const MIN = 60 * 1000;
const limits = {
  // Password / two-step code guessing (per IP; each account also locks after 5 wrong tries).
  login: limiter({ name: "login", windowMs: 10 * MIN, max: 40, message: "Too many sign-in attempts from your network. Please wait 10 minutes and try again." }),
  // Emails sent to people: password reset, sign-up / verification.
  email: limiter({ name: "email", windowMs: 60 * MIN, max: 10, message: "Too many requests from your network. Please wait an hour and try again." }),
  // Opening invitation / reset / verification links.
  links: limiter({ name: "links", windowMs: 10 * MIN, max: 60 }),
  // Public forms and pages (seller registration, unsubscribe).
  publicForm: limiter({ name: "public", windowMs: 60 * MIN, max: 30 }),
  // Everything else under /api, per IP (shared by everyone in one office): far above normal use.
  api: limiter({ name: "api", windowMs: MIN, max: 1500, message: "Too many requests from your network right now — please wait a minute." }),
};

module.exports = { limiter, limits, _buckets: buckets };
