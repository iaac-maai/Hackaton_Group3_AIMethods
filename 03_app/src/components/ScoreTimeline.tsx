import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ScoredWindow } from "../api";
import { isTrained } from "../threshold";

// Window scores over the clip timeline. Each bar spans the window's real start..end time (from the
// API), so gaps show windows the server did not score. Bars above the threshold in use get the
// status colour plus a ▲ marker (never colour alone). The trained threshold is a solid line; an
// exploratory threshold, when set, is a separate dashed line with its own label.
// Keyboard: Tab to the chart, ←/→ (Home/End) to move between windows, Enter/Space to play.

const PAD = { l: 44, r: 14, t: 22, b: 28 };

interface Props {
  windows: ScoredWindow[];
  trainedThreshold: number;
  threshold: number;          // threshold in use for marking (trained unless the user changed it)
  flagged: boolean[];         // per window, above `threshold`
  durationS: number;
  windowS: number;
  canPlay: boolean;
  onSelect: (w: ScoredWindow) => void;
  linked?: number | null;                       // display only: window number hovered elsewhere (e.g. a flagged-moment button)
  onHover?: (window: number | null) => void;    // display only: report the hovered window number
}

const endOf = (w: ScoredWindow, windowS: number) => w.end_seconds ?? w.start_seconds + windowS;

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);   // rounded data end at the top, square on the baseline
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Width of the chart's container, so text stays at real pixel size on small screens. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, Math.max(280, width)] as const;
}

export function ScoreTimeline({ windows, trainedThreshold, threshold, flagged, durationS, windowS, canPlay, onSelect, linked = null, onHover }: Props) {
  const [plotRef, W] = useWidth<HTMLDivElement>(720);
  const H = W < 480 ? 210 : 240;
  const [hover, setHover] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);   // keyboard position
  const custom = !isTrained(threshold, trainedThreshold);

  const maxScore = Math.max(trainedThreshold, threshold, ...windows.map((w) => w.reconstruction_score)) * 1.15 || 1;
  const span = Math.max(durationS, ...windows.map((w) => endOf(w, windowS)), windowS);
  const x = (s: number) => PAD.l + (s / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / maxScore) * (H - PAD.t - PAD.b);
  // x ticks at least ~56 px apart, on whole seconds
  const tickStep = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => (s / span) * (W - PAD.l - PAD.r) >= 56) ?? 300;
  const ticks = Array.from({ length: Math.floor(span / tickStep) + 1 }, (_, i) => i * tickStep);
  const linkedIdx = linked == null ? -1 : windows.findIndex((w) => w.window === linked);
  const shown = hover ?? (linkedIdx >= 0 ? linkedIdx : null) ?? active;
  const focused = shown == null ? null : windows[shown];
  const count = flagged.filter(Boolean).length;

  useEffect(() => { setActive(null); setHover(null); }, [windows]);

  function onKeyDown(e: KeyboardEvent) {
    if (!windows.length) return;
    const last = windows.length - 1;
    const cur = active ?? -1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(last, cur + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, cur < 0 ? 0 : cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if ((e.key === "Enter" || e.key === " ") && active != null) {
      e.preventDefault();
      if (canPlay) onSelect(windows[active]);
      return;
    }
    if (next != null) { e.preventDefault(); setActive(next); }
  }

  const describe = (i: number) => {
    const w = windows[i];
    return `Window ${w.window}, ${w.start_seconds.toFixed(1)} to ${endOf(w, windowS).toFixed(1)} seconds, score ${w.reconstruction_score.toFixed(3)}, ` +
      `${flagged[i] ? "above" : "at or below"} ${custom ? "your" : "the trained"} threshold.`;
  };

  // Keep the tooltip inside the chart on narrow screens.
  const tooltipLeft = focused ? Math.min(82, Math.max(18, (((x(focused.start_seconds) + x(endOf(focused, windowS))) / 2) / W) * 100)) : 0;

  return (
    <figure className="timeline card">
      <figcaption>
        <div>
          <strong className="card-title">Movement deviation per window</strong>
          <span className="muted card-sub">{windows.length} windows · {windowS.toFixed(2)} s each · higher = less like the reference movements</span>
        </div>
        <span className="legend">
          <span><span className="swatch normal" aria-hidden="true" /> At or below</span>
          <span><span className="swatch flagged" aria-hidden="true" /> ▲ Above</span>
          <span><span className="swatch line trained" aria-hidden="true" /> Trained threshold</span>
          {custom && <span><span className="swatch line custom" aria-hidden="true" /> Your threshold</span>}
        </span>
      </figcaption>

      <div className="timeline-plot" ref={plotRef} tabIndex={0} role="group" onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        aria-label={`Score chart: ${windows.length} windows, ${count} above ${custom ? "your" : "the trained"} threshold. ` +
          `Use the arrow keys to move between windows${canPlay ? " and Enter to play one" : ""}.`}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(maxScore * f)} y2={y(maxScore * f)} />
              {f % 0.5 === 0 && <text className="axis" x={PAD.l - 6} y={y(maxScore * f) + 4} textAnchor="end">{(maxScore * f).toFixed(2)}</text>}
            </g>
          ))}
          {ticks.map((s) => (
            <text key={s} className="axis" x={x(s)} y={H - 8} textAnchor="middle">{s}s</text>
          ))}
          {windows.map((w, i) => {
            const x0 = x(w.start_seconds) + 1, x1 = x(endOf(w, windowS)) - 1;
            const bw = Math.max(2, x1 - x0);
            const top = y(w.reconstruction_score);
            return (
              <g key={w.window} className={`bar ${flagged[i] ? "flagged pulse-once" : "normal"} ${shown === i ? "hover" : ""} ${active === i ? "active" : ""}`}
                onMouseEnter={() => { setHover(i); onHover?.(w.window); }} onMouseLeave={() => { setHover(null); onHover?.(null); }} onClick={() => canPlay && onSelect(w)}>
                <rect className="hit" x={x0} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} />
                {active === i && <rect className="focus-ring" x={x0 - 2} y={PAD.t - 2} width={bw + 4} height={H - PAD.t - PAD.b + 4} rx={5} />}
                <path d={barPath(x0, top, bw, y(0) - top)} />
                {flagged[i] && bw >= 6 && <text className="marker" x={(x0 + x1) / 2} y={top - 4} textAnchor="middle">▲</text>}
              </g>
            );
          })}
          <line className="baseline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
          <line className="threshold trained" x1={PAD.l} x2={W - PAD.r} y1={y(trainedThreshold)} y2={y(trainedThreshold)} />
          <text className="threshold-label trained" x={PAD.l + 4} y={y(trainedThreshold) - 5}>Trained {trainedThreshold.toFixed(3)}</text>
          {custom && (
            <>
              <line className="threshold custom" x1={PAD.l} x2={W - PAD.r} y1={y(threshold)} y2={y(threshold)} />
              <text className="threshold-label custom" x={W - PAD.r - 2} y={y(threshold) + (threshold < trainedThreshold ? 14 : -5)} textAnchor="end">
                Yours {threshold.toFixed(3)}
              </text>
            </>
          )}
        </svg>
        {focused && shown != null && (
          <div className="tooltip" style={{ left: `${tooltipLeft}%` }}>
            <div>Window {focused.window} · {focused.start_seconds.toFixed(2)}–{endOf(focused, windowS).toFixed(2)} s</div>
            <div>Score <strong>{focused.reconstruction_score.toFixed(3)}</strong> {flagged[shown] ? "▲ above" : "at or below"} {custom ? "your" : "trained"} threshold</div>
            {custom && focused.above_threshold !== flagged[shown] && (
              <div className="muted">{focused.above_threshold ? "Above" : "Not above"} the trained threshold</div>
            )}
            {canPlay && <div className="muted">{active === shown ? "Enter" : "Click"} to play this moment</div>}
          </div>
        )}
        <p className="sr-only" aria-live="polite">{active != null ? describe(active) : ""}</p>
      </div>

      <details className="table-view">
        <summary>Show as table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Window</th><th>Start (s)</th><th>End (s)</th><th>Score</th><th>Above trained</th>
                {custom && <th>Above yours</th>}
              </tr>
            </thead>
            <tbody>
              {windows.map((w, i) => (
                <tr key={w.window}>
                  <td>{w.window}</td><td>{w.start_seconds.toFixed(2)}</td><td>{endOf(w, windowS).toFixed(2)}</td>
                  <td>{w.reconstruction_score.toFixed(3)}</td><td>{w.above_threshold ? "▲ yes" : "no"}</td>
                  {custom && <td>{flagged[i] ? "▲ yes" : "no"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
