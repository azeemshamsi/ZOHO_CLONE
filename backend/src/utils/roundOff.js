// Ledger names that mean rounding off (Tally's "Round Off", "Roundoff", "Rounded Off A/c", "Rounding & Adjustments"…):
// all are OrdexaGo's built-in Rounding & Adjustments ledger.
const RX = /^round(ed|ing)?(off|up|down)?(and)?(adjustments?)?(ac|acc|account)?$/;
const isRoundOffName = (name) => RX.test(String(name || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z]/g, ""));
module.exports = { isRoundOffName };
