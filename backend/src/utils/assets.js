/**
 * Depreciation schedules. One charge per month (at month end), the first month pro-rated by days.
 *   SLM: (cost − salvage) / (life × 12) each month.
 *   WDV: rate% a year on the book value at the start of each financial year (April), /12 a month.
 * Depreciation never takes the book value below the salvage value, and stops on disposal.
 */
const { round2 } = require("./http");

const monthEnd = (y, m) => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));

function schedule(a, until) {
  const out = [];
  if (a.method === "none") return out;
  const start = new Date(a.depreciationStart || a.acquisitionDate);
  const stop = a.status === "disposed" && a.disposal?.date ? new Date(a.disposal.date) : null;
  const eod = (d) => {
    const x = new Date(d);
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 23, 59, 59, 999);
  };
  const stopT = stop ? eod(stop) : Infinity;
  const end = new Date(Math.min(until ? eod(until) : Infinity, stopT));
  const floor = Number(a.salvageValue) || 0;
  let book = Number(a.cost);
  let acc = 0;
  let fyBase = book;
  const slm = a.usefulLifeYears > 0 ? (a.cost - floor) / (a.usefulLifeYears * 12) : 0;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  for (let guard = 0; guard < 1200 && book > floor + 0.004; guard++) {
    const me = monthEnd(y, m);
    const periodEnd = stopT < me.getTime() ? new Date(stopT) : me; // disposal month: depreciate up to the disposal date
    if (periodEnd > end) break;
    if (m === 3 && guard > 0) fyBase = book; // new financial year
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const from = guard === 0 ? start.getUTCDate() : 1;
    const to = periodEnd.getUTCMonth() === m && periodEnd.getUTCFullYear() === y ? periodEnd.getUTCDate() : days;
    const share = Math.max(0, to - from + 1) / days;
    let amt = a.method === "slm" ? slm * share : (fyBase * (a.rate || 0)) / 100 / 12 * share;
    amt = round2(Math.min(amt, book - floor));
    if (amt > 0) {
      acc = round2(acc + amt);
      book = round2(a.cost - acc);
      out.push({ date: periodEnd, amount: amt, accumulated: acc, bookValue: book });
    }
    if (periodEnd.getTime() === stopT) break;
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

// Accumulated depreciation and book value on a date.
function position(a, date) {
  const s = schedule(a, date);
  const acc = s.length ? s[s.length - 1].accumulated : 0;
  return { accumulated: acc, bookValue: round2(a.cost - acc) };
}

module.exports = { schedule, position };
