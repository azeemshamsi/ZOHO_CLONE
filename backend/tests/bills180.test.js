const test = require("node:test");
const assert = require("node:assert");
const Bill = require("../src/models/Bill");
const { istToday } = require("../src/utils/time");

const DAY = 86400000;
const ago = (n, ist = false) => new Date(istToday().getTime() - n * DAY - (ist ? 5.5 * 3600000 : 0));

test("bills over 180 days and reaching it, with ITC on the unpaid part", async () => {
  Bill.find = () => ({
    lean: async () => [
      { _id: "a", billNumber: "B1", vendorName: "V", date: ago(200), total: 1180, balance: 590, cgst: 90, sgst: 90 }, // over, half unpaid
      { _id: "b", billNumber: "B2", vendorName: "V", date: ago(181, true), total: 1050, balance: 1050, igst: 50 }, // over (imported at India midnight)
      { _id: "c", billNumber: "B3", vendorName: "V", date: ago(180), total: 100, balance: 100 }, // exactly 180: still within
      { _id: "d", billNumber: "B4", vendorName: "V", date: ago(160), total: 100, balance: 100 }, // soon
      { _id: "e", billNumber: "B5", vendorName: "V", date: ago(100), total: 100, balance: 100 }, // not yet
      { _id: "f", billNumber: "B6", vendorName: "V", date: ago(300), total: 100, balance: 0 }, // paid
    ],
  });
  delete require.cache[require.resolve("../src/utils/bills180")];
  const { bills180 } = require("../src/utils/bills180");
  const { rows, summary } = await bills180("org");
  assert.deepEqual(rows.map((r) => [r.number, r.state, r.age]), [["B1", "over", 200], ["B2", "over", 181], ["B3", "soon", 180], ["B4", "soon", 160]]);
  assert.equal(summary.over.count, 2);
  assert.equal(summary.over.balance, 1640);
  assert.equal(summary.over.itc, 140); // 90 of 180 GST (half unpaid) + 50
  assert.equal(summary.soon.count, 2);
});
