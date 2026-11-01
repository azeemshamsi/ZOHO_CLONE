const env = require("./config/env");
const connectDatabase = require("./config/database");
const app = require("./app");

connectDatabase()
  .then(() => {
    app.listen(env.PORT, () => console.log(`OrdexaGo running on port ${env.PORT}`));
    require("./utils/recurring").startScheduler();
  })
  .catch((err) => {
    console.error("Could not start:", err.message);
    process.exit(1);
  });
