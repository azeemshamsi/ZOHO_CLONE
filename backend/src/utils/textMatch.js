// Search text in the app instead of with database regexes (unreliable on the Oracle MongoDB API).
// True when every word typed appears in one of the values (case-insensitive).
function textMatch(q, values) {
  const words = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = values.flat(Infinity).filter((v) => v !== undefined && v !== null && v !== "").join(" | ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

module.exports = { textMatch };
