// Back in OrdexaGo works like Tally's Esc: one level up the hierarchy, not through the browser history.
//   form (new/edit) → the document (or its list) → the list → Home
//   a report → Reports → Home
// A page opened by clicking inside another page that isn't its parent (an invoice opened from GSTR-1, a ledger
// opened from the Trial Balance) goes back to the page it was opened from. Lists come back with their own
// search, filters and tab. The browser's own back button is left alone.
import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

// Pages with a list but no page for a single document (their documents open in the edit form).
const NO_VIEW = ["expenses", "payments-made", "payments"];

const KEY_DRILL = "ox-back-drill";
const KEY_LAST = "ox-back-last";
const read = (k) => {
  try {
    return JSON.parse(sessionStorage.getItem(k) || "{}");
  } catch {
    return {};
  }
};
const write = (k, v) => {
  try {
    sessionStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode etc. */
  }
};

// The page one level up from a path.
export function parentOf(path) {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return null;
  const seg = p.split("/").filter(Boolean);
  if (seg.length === 1) return "/";
  if (seg.length >= 3 && seg[seg.length - 1] === "edit") {
    if (NO_VIEW.includes(seg[0])) return `/${seg[0]}`;
    return `/${seg.slice(0, -1).join("/")}`;
  }
  return `/${seg.slice(0, -1).join("/")}`;
}
const chain = (path) => {
  const out = [];
  for (let p = parentOf(path); p; p = parentOf(p)) out.push(p);
  return out;
};
const isForm = (path) => /\/(new|edit)$/.test(path);

// Where Back / Esc goes from this page.
export function backTarget(loc) {
  const path = loc.pathname;
  const drill = read(KEY_DRILL)[path];
  if (drill) return drill;
  const up = parentOf(path);
  if (!up) return null;
  const last = read(KEY_LAST)[up];
  return up + (last || "");
}

// Sidebar links, Go To, voucher shortcuts and the New Invoice button are jumps: the page they open goes back up
// its own hierarchy, not to the page you were on.
export const markJump = () => {
  window.__oxJump = true;
};

export function useBack() {
  const navigate = useNavigate();
  const loc = useLocation();
  return () => {
    const t = backTarget(loc);
    if (!t) return;
    const d = read(KEY_DRILL);
    delete d[loc.pathname];
    write(KEY_DRILL, d);
    window.__oxBack = true;
    navigate(t);
  };
}

// Mounted once (Layout): remembers each list's search and where drilled pages were opened from.
export function BackMemory() {
  const loc = useLocation();
  const navType = useNavigationType();
  const prev = useRef(null);
  useEffect(() => {
    const last = read(KEY_LAST);
    last[loc.pathname] = loc.search || "";
    write(KEY_LAST, last);
    const from = prev.current;
    const jump = window.__oxJump;
    const back = window.__oxBack;
    window.__oxJump = false;
    window.__oxBack = false;
    prev.current = { path: loc.pathname, full: loc.pathname + loc.search };
    // Browser back/forward (POP) or our own Back: nothing new to remember.
    if (!from || from.path === loc.pathname || back || navType === "POP") return;
    const d = read(KEY_DRILL);
    const related = chain(loc.pathname).includes(from.path) || chain(from.path).includes(loc.pathname);
    if (jump || related || isForm(from.path)) delete d[loc.pathname];
    else d[loc.pathname] = from.full;
    write(KEY_DRILL, d);
  }, [loc.pathname, loc.search]);
  return null;
}
