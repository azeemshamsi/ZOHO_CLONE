import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Type-to-search picker for long lists (customers, vendors, items).
 * options: [{ value, label, sub?, search? }] — matches every word typed against label, sub and search.
 */
export default function SearchSelect({ value, options, onChange, placeholder = "Type to search…", required, className = "", emptyText = "No matches", footer, autoFocus, disabled }) {
  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);
  const [text, setText] = useState(selected?.label || "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const list = useRef(null);

  // Show the chosen option's name when the value changes from outside.
  useEffect(() => {
    if (!open) setText(selected?.label || "");
  }, [selected, open]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && finish();
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  });

  const matches = useMemo(() => {
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!open || !words.length || text === selected?.label) return options.slice(0, 60);
    const scored = [];
    for (const o of options) {
      const label = o.label.toLowerCase();
      const hay = `${label} ${(o.sub || "").toLowerCase()} ${(o.search || "").toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) continue;
      scored.push([label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2, o]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
    return scored.slice(0, 60).map((x) => x[1]);
  }, [options, text, open, selected]);

  const finish = () => {
    setOpen(false);
    setText(selected?.label || "");
  };
  const pick = (o) => {
    onChange(o ? o.value : "");
    setText(o ? o.label : "");
    setOpen(false);
  };
  const key = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (matches[active]) pick(matches[active]);
    } else if (e.key === "Escape") finish();
    else if (e.key === "Tab" && open) {
      if (matches.length === 1 || (text && text !== selected?.label && matches[active])) pick(matches[active]);
      else finish();
    }
  };
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  return (
    <div className={`ss ${className}`} ref={box}>
      <input
        value={text}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          if (!e.target.value && value) onChange("");
        }}
        onKeyDown={key}
      />
      {/* keeps the form's required check honest: typed text without a pick doesn't count */}
      {required && <input tabIndex={-1} aria-hidden="true" className="ss-req" required value={value || ""} onChange={() => {}} />}
      {open && (
        <div className="ss-list" ref={list} role="listbox">
          {matches.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`ss-opt ${i === active ? "active" : ""} ${o.value === value ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{o.label}</span>
              {o.sub && <span className="ss-sub">{o.sub}</span>}
            </div>
          ))}
          {!matches.length && <div className="ss-empty">{emptyText}</div>}
          {matches.length === 60 && <div className="ss-empty">Keep typing to narrow down…</div>}
          {footer && <div className="ss-foot" onMouseDown={(e) => e.preventDefault()}>{footer}</div>}
        </div>
      )}
    </div>
  );
}

// Option lists for the usual pickers.
export const partyOptions = (list) =>
  list.map((c) => ({ value: c._id, label: c.displayName, sub: [c.companyName && c.companyName !== c.displayName ? c.companyName : "", c.gstin].filter(Boolean).join(" · "), search: [c.phone, c.email].filter(Boolean).join(" ") }));
export const itemOptions = (list) => list.map((it) => ({ value: it._id, label: it.name, sub: [it.sku, it.hsnSac && `HSN ${it.hsnSac}`].filter(Boolean).join(" · "), search: it.description || "" }));
