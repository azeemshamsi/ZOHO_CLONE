const env = require("./config/env");
const connectDatabase = require("./config/database");
const app = require("./app");

connectDatabase()
  .then(async () => {
    // Serve straight away; one-time migrations and credential re-encryption run alongside (logged), so a slow
    // database call can't keep the site down.
    // HOST=127.0.0.1 on the server: only nginx (same machine) can reach the app; the internet goes through HTTPS.
    const host = process.env.HOST || undefined;
    app.listen(env.PORT, host, () => console.log(`OrdexaGo running on ${host || "all interfaces"}, port ${env.PORT}`));
    const t0 = Date.now();
    console.log("Startup: checking migrations…");
    await require("./utils/migrations")
      .runMigrations()
      .catch((e) => console.error("Migrations failed:", e.message));
    console.log(`Startup: migrations checked in ${Math.round((Date.now() - t0) / 1000)}s`);
    await require("./utils/secrets")
      .reencryptAll()
      .catch((e) => console.error("Encrypting stored credentials failed:", e.message));
    console.log(`Startup: credentials checked in ${Math.round((Date.now() - t0) / 1000)}s`);
    require("./utils/recurring").startScheduler();
  })
  .catch((err) => {
    console.error("Could not start:", err.message);
    process.exit(1);
  });
