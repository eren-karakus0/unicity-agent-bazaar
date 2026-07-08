/**
 * Brand mark: a hexagon (Unicity's motif) enclosing a hub-and-spoke glyph -
 * the bazaar as the hub that connects agents. Pure inline SVG so it stays crisp
 * at any size and needs no network fetch.
 */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      className="brand__mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Agent Bazaar"
    >
      <defs>
        <linearGradient id="bz-hex" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff9a4d" />
          <stop offset="1" stopColor="#ff6f00" />
        </linearGradient>
      </defs>
      <path
        className="brand__hex"
        d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"
        fill="url(#bz-hex)"
      />
      {/* hub-and-spoke: a center node wired to three agent nodes */}
      <g stroke="#1a0d00" strokeWidth="1.6" strokeLinecap="round">
        <line x1="16" y1="16" x2="16" y2="9.5" />
        <line x1="16" y1="16" x2="10.4" y2="19.3" />
        <line x1="16" y1="16" x2="21.6" y2="19.3" />
      </g>
      <g fill="#1a0d00">
        <circle className="brand__node" cx="16" cy="9.5" r="2" />
        <circle className="brand__node" cx="10.4" cy="19.3" r="2" />
        <circle className="brand__node" cx="21.6" cy="19.3" r="2" />
      </g>
      <circle cx="16" cy="16" r="2.6" fill="#1a0d00" />
    </svg>
  );
}
