const path = require("path");

// Load backend/.env when running locally. On Render, variables come from the dashboard.
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 8080,
  MONGODB_URI: process.env.MONGODB_URI || process.env.DB || "",
  JWT_SECRET: process.env.JWT_SECRET || process.env.JWTPRIVATEKEY || "",
  // Public URL of the app, used in email links, e.g. https://mgi.onrender.com
  APP_URL: (process.env.APP_URL || process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, ""),
  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_SECURE: String(process.env.SMTP_SECURE || "false") === "true",
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  REQUIRE_EMAIL_VERIFICATION: String(process.env.REQUIRE_EMAIL_VERIFICATION || "false") === "true",
};

env.emailEnabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

if (!env.JWT_SECRET) {
  if (env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  env.JWT_SECRET = "dev-only-secret-change-me";
}

module.exports = env;
