export function LogoMark({ size = 32 }) {
  return <img src="/logo-mark.png" width={size} height={size} alt="" aria-hidden="true" style={{ display: "block", objectFit: "contain" }} />;
}

export default function Logo({ size = 32, light = false, tagline = false }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <LogoMark size={size} />
      <span className="logo-text">
        <span className="logo-name">
          Ordexa<span className="logo-go">Go</span>
        </span>
        {tagline && <span className="logo-tag">Orders · Books · Stock</span>}
      </span>
    </span>
  );
}
