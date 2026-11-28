const mongoose = require("mongoose");

/**
 * Automatic bank statement import from email (Banking → Auto-import): OrdexaGo reads a mailbox over IMAP (a Gmail
 * with an app password), opens statement attachments (CSV / Excel, password-protected Excel too) and imports them
 * into the bank account whose account number is in the file.
 */
const bankFeedSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    host: { type: String, default: "imap.gmail.com" },
    port: { type: Number, default: 993 },
    user: { type: String, default: "" },
    imapPass: { type: String, default: "" },
    senders: { type: String, default: "" }, // only mail from these addresses / domains (comma separated); blank = any
    // Bank accounts fed this way: account code ↔ the bank's account number (as printed in the statement).
    accounts: [{ _id: false, code: String, accountNumber: String, enabled: { type: Boolean, default: true } }],
    filePasswords: { type: mongoose.Schema.Types.Mixed, default: {} }, // account code → password for its statement files
    lastRunAt: Date,
    lastOkAt: Date,
    lastError: { type: String, default: "" },
    processed: { type: [String], default: [] }, // Message-IDs already handled (last 2000)
    log: { type: [mongoose.Schema.Types.Mixed], default: [] }, // last 100 results
  },
  { timestamps: true },
);

const { encryptFields, FIELDS } = require("../utils/secrets");
encryptFields(bankFeedSchema, FIELDS.BankFeed);

module.exports = mongoose.model("BankFeed", bankFeedSchema);
