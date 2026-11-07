// Encryption of stored third-party secrets (no database).
const test = require("node:test");
const assert = require("node:assert");
const S = require("../src/utils/secrets");
const AmazonAccount = require("../src/models/AmazonAccount");
const CourierAccount = require("../src/models/CourierAccount");
const Organization = require("../src/models/Organization");
const GspAccount = require("../src/models/GspAccount");
const { Types } = require("mongoose");

test("round trip, random IV, prefix", () => {
  const a = S.encrypt("Atzr|secret-refresh-token");
  const b = S.encrypt("Atzr|secret-refresh-token");
  assert.ok(a.startsWith("enc:v1:"));
  assert.notEqual(a, b);
  assert.equal(S.decrypt(a), "Atzr|secret-refresh-token");
  assert.equal(S.encrypt(a), a, "already encrypted values aren't encrypted twice");
  assert.equal(S.encrypt(""), "");
  assert.equal(S.decrypt("plain-legacy"), "plain-legacy");
});

test("tampered ciphertext doesn't decrypt", () => {
  const a = S.encrypt("hello");
  const raw = Buffer.from(a.slice(7), "base64");
  raw[raw.length - 1] ^= 1;
  assert.equal(S.decrypt("enc:v1:" + raw.toString("base64")), "");
});

test("CREDENTIALS_KEY: hex or base64, 32 bytes; old values still readable after it's set", () => {
  const hex = "a".repeat(64);
  assert.equal(S.parseKey(hex).length, 32);
  assert.equal(S.parseKey(Buffer.alloc(32, 7).toString("base64")).length, 32);
  assert.throws(() => S.parseKey("short"));
  S.resetKeys();
  const old = S.encrypt("written-with-derived-key");
  process.env.CREDENTIALS_KEY = hex;
  S.resetKeys();
  assert.equal(S.decrypt(old), "written-with-derived-key");
  const nu = S.encrypt("x");
  delete process.env.CREDENTIALS_KEY;
  S.resetKeys();
  assert.equal(S.decrypt(nu), "", "the derived key can't read CREDENTIALS_KEY values");
});

test("model fields are stored encrypted and read as plain text", () => {
  const a = new AmazonAccount({ organization: new Types.ObjectId(), clientId: "amzn1.app", clientSecret: "cs-1", refreshToken: "Atzr|r" });
  assert.ok(a.get("clientSecret", null, { getters: false }).startsWith("enc:v1:"));
  assert.equal(a.clientSecret, "cs-1");
  assert.equal(a.refreshToken, "Atzr|r");
  a.accessToken = "Atza|t";
  assert.ok(a.toObject().accessToken.startsWith("enc:v1:"));
  assert.equal(a.accessToken, "Atza|t");
  const j = JSON.stringify(a.toJSON());
  assert.ok(!j.includes("cs-1") && !j.includes("Atzr") && !j.includes("enc:v1"));
});

test("courier credentials (mixed) and nested organization secrets", () => {
  const c = new CourierAccount({ organization: new Types.ObjectId(), carrier: "shiprocket", name: "SR", credentials: { email: "a@b.in", password: "pw" } });
  assert.ok(c.toObject().credentials.password.startsWith("enc:v1:"));
  assert.equal(c.credentials.password, "pw");
  assert.equal(c.credentials.email, "a@b.in");
  assert.deepEqual(c.toJSON().credentialKeys.sort(), ["email", "password"]);
  const creds = { ...c.credentials, password: "pw2" };
  c.credentials = creds;
  assert.equal(c.credentials.password, "pw2");

  const o = new Organization({ name: "X", state: "09", smtp: { provider: "brevo", apiKey: "xkeysib-1", user: "a@b.in" }, ai: { geminiKey: "AIza1" } });
  assert.ok(o.toObject().smtp.apiKey.startsWith("enc:v1:"));
  assert.equal(o.smtp.apiKey, "xkeysib-1");
  assert.equal(o.ai.geminiKey, "AIza1");
  const oj = o.toJSON();
  assert.equal(oj.smtp.hasApiKey, true);
  assert.equal(oj.ai.hasGeminiKey, true);
  assert.ok(!JSON.stringify(oj).includes("AIza1"));

  const g = new GspAccount({ organization: new Types.ObjectId(), token: "tok-1234" });
  assert.equal(g.token, "tok-1234");
  assert.equal(g.toJSON().tokenEnd, "1234");
});

test("legacy plain values loaded from the database still read", () => {
  const a = AmazonAccount.hydrate({ _id: new Types.ObjectId(), organization: new Types.ObjectId(), clientSecret: "legacy-plain" });
  assert.equal(a.clientSecret, "legacy-plain");
});

test("start-up pass encrypts plain values and moves derived-key values to CREDENTIALS_KEY", async () => {
  const mongoose = require("mongoose");
  require("../src/models/ShopifyStore");
  require("../src/models/User");
  S.resetKeys();
  const derivedValue = S.encrypt("old-derived");
  const rows = {
    AmazonAccount: [{ _id: 1, clientSecret: "plain-cs", refreshToken: "", accessToken: derivedValue }],
    ShopifyStore: [],
    CourierAccount: [{ _id: 2, credentials: { token: "plain-tok", user: "" }, token: "" }],
    GspAccount: [],
    Organization: [{ _id: 3, smtp: { pass: "", apiKey: "xk" }, ai: {} }],
    User: [{ _id: 4, totp: { secret: "", pendingSecret: "" } }],
  };
  const updates = [];
  for (const name of Object.keys(rows)) {
    const c = mongoose.model(name).collection;
    c.find = () => ({ toArray: async () => rows[name] });
    c.updateOne = async (q, u) => updates.push({ name, ...q, set: u.$set });
  }
  process.env.CREDENTIALS_KEY = "b".repeat(64);
  S.resetKeys();
  const r = await S.reencryptAll();
  assert.deepEqual(r, { AmazonAccount: 1, CourierAccount: 1, Organization: 1 });
  const a = updates.find((u) => u.name === "AmazonAccount").set;
  assert.equal(S.decrypt(a.clientSecret), "plain-cs");
  assert.notEqual(a.accessToken, derivedValue);
  delete process.env.CREDENTIALS_KEY;
  S.resetKeys();
  assert.equal(S.decrypt(a.accessToken), "", "now under CREDENTIALS_KEY, not the derived key");
  process.env.CREDENTIALS_KEY = "b".repeat(64);
  S.resetKeys();
  assert.equal(S.decrypt(a.accessToken), "old-derived");
  const c = updates.find((u) => u.name === "CourierAccount").set;
  assert.equal(S.decrypt(c.credentials.token), "plain-tok");
  assert.equal(c.credentials.user, "");
  assert.equal(S.decrypt(updates.find((u) => u.name === "Organization").set["smtp.apiKey"]), "xk");
  delete process.env.CREDENTIALS_KEY;
  S.resetKeys();
});
