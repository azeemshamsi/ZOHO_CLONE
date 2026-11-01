// Dates in OrdexaGo are calendar dates stored as UTC midnight (e.g. "2026-11-01" -> 2026-11-01T00:00:00Z).
// The server runs in UTC, but the business runs on India time, so "today" must be the India calendar date.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Today's India calendar date, as UTC midnight.
function istToday() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

// Last millisecond of today's India calendar date.
function istEndOfToday() {
  return new Date(istToday().getTime() + 24 * 60 * 60 * 1000 - 1);
}

module.exports = { istToday, istEndOfToday };
