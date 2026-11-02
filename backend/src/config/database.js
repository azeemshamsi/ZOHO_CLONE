const mongoose = require("mongoose");
const env = require("./env");

// Works with MongoDB (Atlas or self-hosted) and with Oracle Autonomous Database through its
// MongoDB API (connection string host ends in .oraclecloudapps.com).
const isOracle = (uri) => /oraclecloudapps\.com|authMechanism=PLAIN/i.test(uri || "");

module.exports = async function connectDatabase() {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is not set");
  }
  mongoose.set("strictQuery", true);
  const oracle = isOracle(env.MONGODB_URI);
  const options = {
    // Always Free Autonomous Database allows about 30 sessions in total; keep the pool well under that.
    maxPoolSize: Number(process.env.DB_POOL_SIZE) || (oracle ? 10 : 20),
    serverSelectionTimeoutMS: 30000,
  };
  if (oracle) {
    // Oracle's MongoDB API needs load-balanced connections and doesn't support retryable writes.
    options.retryWrites = false;
    if (!/loadBalanced=/i.test(env.MONGODB_URI)) options.loadBalanced = true;
    if (!/tls=|ssl=/i.test(env.MONGODB_URI)) options.tls = true;
  }
  await mongoose.connect(env.MONGODB_URI, options);
  mongoose.connection.isOracle = oracle;
  console.log(oracle ? "Connected to Oracle Autonomous Database (MongoDB API)" : "Connected to MongoDB");
};
module.exports.isOracle = isOracle;
