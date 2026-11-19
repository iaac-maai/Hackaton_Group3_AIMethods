import type { ScoredWindow } from "../../api";
import type { Track } from "../../pose/tracks";

// Display-only strips for a track card. They read the track and its scored windows as they are.

const pct = (a: number, total: number) => `${(a / total) * 100}%`;

/** Where in the clip this track is visible: filled runs over the clip's length. */
export function VisibilityStrip({ track, frameCount }: { track: Track; frameCount: number }) {
  if (!(frameCount > 0)) return null;
  const runs: { start: number; end: number }[] = [];
  track.frames.forEach((f, i) => {
    if (!f) return;
    const last = runs[runs.length - 1];
    if (last && last.end === i) last.end = i + 1; else runs.push({ start: i, end: i + 1 });
  });
  const share = Math.round((track.present / frameCount) * 100);
  return (
    <div className="vis-strip-wrap">
      <div className="vis-strip mo-grow-x" aria-hidden="true">
        {runs.map((r) => <span key={r.start} style={{ left: pct(r.start, frameCount), width: pct(r.end - r.start, frameCount) }} />)}
      </div>
      <span className="vis-strip-label">Visible in {share}% of the clip</span>
    </div>
  );
}

/**
 * One block per scored window, placed at its real time in the clip. Orange above the threshold in use,
 * the chart's neutral otherwise; height follows the score. Gaps between blocks are untracked or
 * unscored time, and the track's uncertain stretches are outlined with a dashed box.
 */
export function WindowBlocks({ windows, flagged, durationS, windowS, uncertain, hover, onHover, onSelect, canPlay }: {
  windows: ScoredWindow[]; flagged: boolean[]; durationS: number; windowS: number;
  uncertain: { start: number; end: number }[];   // seconds
  hover: number | null; onHover: (window: number | null) => void;
  onSelect: (w: ScoredWindow) => void; canPlay: boolean;
}) {
  const end = (w: ScoredWindow) => w.end_seconds ?? w.start_seconds + windowS;
  const span = Math.max(durationS, ...windows.map(end), windowS);
  const max = Math.max(...windows.map((w) => w.reconstruction_score), 0) || 1;
  return (
    <div className="win-blocks" role="group" aria-label="Scored windows in time order">
      <div className="win-lane">
        {uncertain.map((u) => (
          <span key={`u${u.start}`} className="win-uncertain" style={{ left: pct(u.start, span), width: pct(Math.max(0, u.end - u.start), span) }}
            title="Uncertain identity" />
        ))}
        {windows.map((w, i) => (
          <button key={w.window} type="button" tabIndex={-1}
            className={`win-block mo-grow-y ${flagged[i] ? "on pulse-once" : ""} ${hover === w.window ? "hover" : ""}`}
            style={{ left: pct(w.start_seconds, span), width: pct(end(w) - w.start_seconds, span), height: `${Math.max(12, (w.reconstruction_score / max) * 100)}%` }}
            title={`${w.start_seconds.toFixed(2)}–${end(w).toFixed(2)} s · score ${w.reconstruction_score.toFixed(3)}${flagged[i] ? " · above threshold" : ""}`}
            aria-label={`Window ${w.window}, ${w.start_seconds.toFixed(1)} to ${end(w).toFixed(1)} seconds, score ${w.reconstruction_score.toFixed(3)}`}
            onMouseEnter={() => onHover(w.window)} onMouseLeave={() => onHover(null)}
            onClick={() => canPlay && onSelect(w)} />
        ))}
      </div>
      <div className="win-axis" aria-hidden="true"><span>0 s</span><span>{span.toFixed(1)} s</span></div>
    </div>
  );
}
