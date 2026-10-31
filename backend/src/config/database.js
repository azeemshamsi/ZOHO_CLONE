const mongoose = require("mongoose");
const env = require("./env");

module.exports = async function connectDatabase() {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is not set");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");
};
