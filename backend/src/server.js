const env = require("./config/env");
const connectDatabase = require("./config/database");
const app = require("./app");

connectDatabase()
  .then(async () => {
    await require("./utils/migrations").runMigrations();
    // Stored API keys: encrypt any still in plain text (and move to CREDENTIALS_KEY once it's set).
    await require("./utils/secrets").reencryptAll().catch((e) => console.error("Encrypting stored credentials failed:", e.message));
    app.listen(env.PORT, () => console.log(`OrdexaGo running on port ${env.PORT}`));
    require("./utils/recurring").startScheduler();
  })
  .catch((err) => {
    console.error("Could not start:", err.message);
    process.exit(1);
  });
