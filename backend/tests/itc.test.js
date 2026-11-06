const test = require("node:test");
const assert = require("node:assert");
const ledger = require("../src/utils/ledger");
const Gstr2b = require("../src/models/Gstr2b");
const Bill = require("../src/models/Bill");

test("ITC month by month: purchases, set-off journal, Tally input ledgers, GSTR-2B", async () => {
  ledger.chartOfAccounts = async () => [{ code: "input_igst", name: "Input IGST" }, { code: "t1", name: "Input CGST 9%" }, { code: "t2", name: "Input SGST 9%" }, { code: "out", name: "Output IGST" }, { code: "ap", name: "AP" }];
  const D = (s) => new Date(`${s}T00:00:00Z`);
  ledger.buildEntries = async () => [
    { date: D("2026-03-20"), type: "Bill", lines: [{ account: "input_igst", debit: 100, credit: 0 }, { account: "ap", debit: 0, credit: 100 }] }, // last FY: opening
    { date: D("2026-04-10"), type: "Bill", lines: [{ account: "t1", debit: 90, credit: 0 }, { account: "t2", debit: 90, credit: 0 }, { account: "ap", debit: 0, credit: 180 }] },
    { date: D("2026-04-25"), type: "Vendor Credit", lines: [{ account: "t1", debit: 0, credit: 9 }, { account: "t2", debit: 0, credit: 9 }] },
    { date: D("2026-05-20"), type: "Journal", lines: [{ account: "out", debit: 250, credit: 0 }, { account: "input_igst", debit: 0, credit: 100 }, { account: "t1", debit: 0, credit: 75 }, { account: "t2", debit: 0, credit: 75 }] },
  ];
  Gstr2b.find = () => ({ lean: async () => [{ period: "2026-04", docs: [{ camt: 90, samt: 90, iamt: 0, itc: true }, { camt: 5, samt: 5, itc: false }, { camt: -9, samt: -9, itc: true }] }] });
  Bill.find = () => ({ lean: async () => [] });
  delete require.cache[require.resolve("../src/utils/itc")];
  const { itcSummary } = require("../src/utils/itc");
  const s = await itcSummary("org", { fy: 2026 });
  const apr = s.months.find((m) => m.key === "2026-04");
  const may = s.months.find((m) => m.key === "2026-05");
  assert.equal(s.opening.total, 100);
  assert.equal(apr.taken.total, 162); // 180 − 18 credit note
  assert.equal(apr.b2b.total, 162);
  assert.equal(apr.diff, 0);
  assert.equal(may.used.total, 250);
  assert.equal(s.balance.total, 12); // 100 + 162 − 250
  assert.deepEqual(s.ledgers.map((l) => l.name).sort(), ["Input CGST 9%", "Input IGST", "Input SGST 9%"]);
});
