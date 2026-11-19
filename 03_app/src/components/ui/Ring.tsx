/** A small progress ring showing a share (0–1). Decorative: the tile's number and caption carry the value. */
export function Ring({ value, size = 54 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = 20, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle className="ring-track" cx="24" cy="24" r={r} />
      <circle className="ring-value mo-ring" cx="24" cy="24" r={r} strokeDasharray={`${v * c} ${c}`} transform="rotate(-90 24 24)" />
      <text x="24" y="28" textAnchor="middle" className="ring-text">{Math.round(v * 100)}%</text>
    </svg>
  );
}
