import { isoDate } from "./format";

const d = (y, m, day) => isoDate(new Date(y, m, day));

// Indian financial year starts 1 April.
function fyStartYear(now) {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

export function periodRange(key, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  const fy = fyStartYear(now);
  switch (key) {
    case "today":
      return { from: isoDate(now), to: isoDate(now) };
    case "this_month":
      return { from: d(y, m, 1), to: d(y, m + 1, 0) };
    case "last_month":
      return { from: d(y, m - 1, 1), to: d(y, m, 0) };
    case "this_quarter":
      return { from: d(y, qStart, 1), to: d(y, qStart + 3, 0) };
    case "last_quarter":
      return { from: d(y, qStart - 3, 1), to: d(y, qStart, 0) };
    case "last_fy":
      return { from: d(fy - 1, 3, 1), to: d(fy, 2, 31) };
    case "this_fy":
    default:
      return { from: d(fy, 3, 1), to: d(fy + 1, 2, 31) };
  }
}

export const PERIODS = [
  ["this_month", "This Month"],
  ["last_month", "Last Month"],
  ["this_quarter", "This Quarter"],
  ["last_quarter", "Last Quarter"],
  ["this_fy", "This Financial Year"],
  ["last_fy", "Last Financial Year"],
  ["custom", "Custom"],
];

export const fmtRange = (from, to) => {
  const f = (s) => new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return `${f(from)} – ${f(to)}`;
};

// Download every table inside `el` as one CSV file.
export function exportCsv(el, filename) {
  const rows = [];
  el.querySelectorAll("h3, table").forEach((node) => {
    if (node.tagName === "H3") {
      rows.push([node.textContent.trim()]);
      return;
    }
    node.querySelectorAll("tr").forEach((tr) => {
      rows.push([...tr.querySelectorAll("th, td")].map((c) => c.textContent.replace(/₹/g, "").replace(/,/g, "").trim()));
    });
    rows.push([]);
  });
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
