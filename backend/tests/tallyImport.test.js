const test = require("node:test");
const assert = require("node:assert");
const { lineRates } = require("../src/utils/import/tally");

test("mixed GST rates on one voucher follow Tally's per-rate tax ledgers", () => {
  // Wall shelves at 5% and a side table at 18% on one inter-state invoice.
  const rates = lineRates([149996.28, 5081.36], [
    { ledger: "IGST 5%", amount: 7499.81 },
    { ledger: "IGST 18%", amount: 914.64 },
  ]);
  assert.deepStrictEqual(rates, [5, 18]);
});

test("CGST + SGST ledgers count as the combined rate, untaxed lines get 0", () => {
  const rates = lineRates([16335.27, 181.26], [
    { ledger: "Input CGST 9%", amount: 1470.17 },
    { ledger: "Input SGST 9%", amount: 1470.18 },
  ]);
  assert.deepStrictEqual(rates, [18, 0]);
});

test("one rate for every line when it matches", () => {
  assert.deepStrictEqual(lineRates([1000, 500], [{ ledger: "Output IGST", amount: 270 }]), [18, 18]);
});

test("a cash sale with stock is an invoice to Cash Sales, paid into Cash at once (its stock moves)", () => {
  const fs = require("fs");
  const path = require("path");
  const { parseFile } = require("../src/utils/import/parse");
  const { normalise } = require("../src/utils/import/tally");
  const p = parseFile(
    "x.xml",
    fs.readFileSync(path.join(__dirname, "fixtures/tallyCashSale.xml")),
  );
  const { records } = normalise(p.xml, { ledgers: {} });
  assert.strictEqual(records.journals.length, 0);
  const [inv] = records.invoices;
  assert.strictEqual(inv.party, "Cash Sales");
  assert.strictEqual(inv.lines[0].name, "Wall Shelves 5%");
  assert.strictEqual(inv.lines[0].quantity, 10);
  assert.strictEqual(inv.replacesJournal, "Sales SH/26-27/44");
  const [pay] = records.payments;
  assert.deepStrictEqual(
    [pay.party, pay.amount, pay.depositTo, pay.mode],
    ["Cash Sales", inv.total, "Cash", "cash"],
  );
  assert.deepStrictEqual(pay.allocations, [{ number: inv.number, amount: inv.total }]);
  assert.ok(records.customers.some((c) => c.displayName === "Cash Sales"));
});

test("Tally Stock Summary as XML: items by OrdexaGo's names, groups skipped, opening column used", () => {
  const SS = require("../src/utils/import/stockSummary");
  const row = (n, opq, opv, clq, clv) =>
    `<DSPACCNAME><DSPDISPNAME>${n}</DSPDISPNAME></DSPACCNAME><DSPSTKINFO><DSPSTKOP><DSPOPQTY>${opq}</DSPOPQTY><DSPOPAMTA>${opv}</DSPOPAMTA></DSPSTKOP><DSPSTKCL><DSPCLQTY>${clq}</DSPCLQTY><DSPCLAMTA>${clv}</DSPCLAMTA></DSPSTKCL></DSPSTKINFO>`;
  const xml =
    "<ENVELOPE>" +
    row("FINISHED GOODS", "", "-1000.00", "", "-800.00") +
    row("44190020 (Kitchen Ware 5%)", "10 PCS", "-600.00", "8 PCS", "-480.00") +
    row("Wooden Kitchen Ware Item (5%)", "10 PCS", "-600.00", "8 PCS", "-480.00") +
    row("WAST AND SCRAP", "", "-400.00", "", "-320.00") +
    row("WAST AND SCRAP", "20 KG", "-400.00", "16 KG", "-320.00") +
    row("Mystery", "3 PCS", "-30.00", "", "") +
    "</ENVELOPE>";
  const buf = Buffer.from(xml);
  assert.ok(SS.isStockSummaryXml(buf));
  const r = SS.parseStockSummaryXml(buf, {
    items: new Set(["wooden kitchen ware item (5%)", "wast and scrap"]),
    groups: new Set(["44190020 (kitchen ware 5%)", "wast and scrap"]),
  });
  assert.strictEqual(r.column, "opening");
  assert.deepStrictEqual(
    r.items.map((i) => [i.name, i.quantity, i.unit, i.value]),
    [
      ["Wooden Kitchen Ware Item (5%)", 10, "pcs", 600],
      ["WAST AND SCRAP", 20, "kg", 400],
    ],
  );
  assert.ok(r.warnings.some((w) => /Mystery/.test(w)));
});
