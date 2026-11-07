// Approved-device gate for Amazon buyer data (no database: models are stubbed).
const test = require("node:test");
const assert = require("node:assert");
const Device = require("../src/models/Device");
const AuditLog = require("../src/models/AuditLog");
const User = require("../src/models/User");
const Membership = require("../src/models/Membership");
const devices = require("../src/utils/devices");

const logged = [];
AuditLog.create = async (d) => (logged.push(d), d);
const none = () => ({ lean: async () => [] });
User.find = none;
Membership.find = none;

let store = [];
Device.findOne = async (q) => store.find((d) => String(d.organization) === String(q.organization) && String(d.user) === String(q.user) && d.deviceId === q.deviceId) || null;
Device.exists = async (q) => store.some((d) => String(d.user) === String(q.user) && d.approved === q.approved);
Device.create = async (d) => (store.push(d), d);
Device.updateOne = async () => ({});

const DEV = "3f1c2a9e-1111-4222-8333-444455556666";
const reqFor = ({ role = "warehouse", superadmin = false, device = DEV } = {}) => ({
  org: "org1",
  user: { _id: "u1", email: "staff@x.in", name: "Staff", superadmin },
  membership: { role },
  ip: "1.2.3.4",
  get: (h) => ({ "x-device-id": device, "user-agent": "UA" })[h.toLowerCase()],
  res: { locals: {} },
});

test("admins and the superadmin are never blocked", async () => {
  store = [];
  assert.equal(await devices.requireApproved(reqFor({ role: "admin" })), true);
  assert.equal(await devices.requireApproved(reqFor({ superadmin: true })), true);
});

test("staff on an unknown device get 403, the device is recorded and the block is logged", async () => {
  store = [];
  logged.length = 0;
  await assert.rejects(
    () => devices.requireApproved(reqFor()),
    (e) => e.status === 403 && /isn't approved for Amazon order data/.test(e.message) && e.details.code === "device_not_approved"
  );
  assert.equal(store.length, 1);
  assert.equal(store[0].approved, false);
  assert.ok(logged.some((l) => l.action === "device_blocked"));
});

test("staff on an approved device pass", async () => {
  store = [{ organization: "org1", user: "u1", deviceId: DEV, approved: true }];
  assert.equal(await devices.requireApproved(reqFor()), true);
});

test("a missing or malformed device id is blocked", async () => {
  store = [];
  await assert.rejects(() => devices.requireApproved(reqFor({ device: "" })), (e) => e.status === 403);
  await assert.rejects(() => devices.requireApproved(reqFor({ device: "<script>" })), (e) => e.status === 403);
});

test("an admin's first device is approved automatically, later ones are not", async () => {
  store = [];
  const d1 = await devices.touch(reqFor({ role: "admin" }));
  assert.equal(d1.approved, true);
  const d2 = await devices.touch(reqFor({ role: "admin", device: "aaaaaaaa-2222-4222-8333-444455556666" }));
  assert.equal(d2.approved, false);
  const s = await devices.touch(reqFor({ role: "warehouse", device: "bbbbbbbb-2222-4222-8333-444455556666" }));
  assert.equal(s.approved, false);
});
