const test = require("node:test");
const assert = require("node:assert");
const { stateOf } = require("../src/utils/subscription");

const at = (s) => new Date(s);
const sub = { validTill: at("2026-11-30T00:00:00Z"), graceDays: 7, status: "active" };

test("owner and no subscriber are unlimited", () => {
  assert.equal(stateOf({ owner: true }).state, "unlimited");
  assert.equal(stateOf(null).state, "unlimited");
});
test("active through the end of the valid-till day in India", () => {
  assert.equal(stateOf(sub, at("2026-11-30T18:00:00Z")).state, "active"); // 11:30 pm IST on the 30th
  assert.equal(stateOf(sub, at("2026-11-30T18:31:00Z")).state, "grace"); // 12:01 am IST on 1 Dec
});
test("grace period, then blocked", () => {
  const g = stateOf(sub, at("2026-12-03T06:00:00Z"));
  assert.equal(g.state, "grace");
  assert.equal(g.blocked, false);
  assert.equal(g.graceLeft, 5);
  const e = stateOf(sub, at("2026-12-07T18:31:00Z"));
  assert.equal(e.state, "expired");
  assert.equal(e.blocked, true);
});
test("suspended is blocked even when valid", () => {
  assert.equal(stateOf({ ...sub, status: "suspended" }, at("2026-11-10T00:00:00Z")).blocked, true);
});
test("days left", () => {
  assert.equal(stateOf(sub, at("2026-11-29T06:00:00Z")).daysLeft, 2);
});
