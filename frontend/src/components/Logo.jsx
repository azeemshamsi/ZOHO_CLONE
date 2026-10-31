export function LogoMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="mgi-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d5efc" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#mgi-g)" />
      <path d="M8 23V10l8 8 8-8v13" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="6.5" r="2.5" fill="#f5a524" />
    </svg>
  );
}

export default function Logo({ size = 32, light = false, tagline = false }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <LogoMark size={size} />
      <span className="logo-text">
        <span className="logo-name">MGI</span>
        {tagline && <span className="logo-tag">Accounting</span>}
      </span>
    </span>
  );
}
