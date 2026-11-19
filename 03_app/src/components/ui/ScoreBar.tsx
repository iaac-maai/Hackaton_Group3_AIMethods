import type { ScoredWindow } from "../../api";

/** A small bar next to a flagged moment: its score relative to the highest score in this result. */
export function ScoreBar({ score, windows }: { score: number; windows: ScoredWindow[] }) {
  const max = Math.max(...windows.map((w) => w.reconstruction_score), 0) || 1;
  return (
    <span className="score-bar" aria-hidden="true">
      <span className="mo-grow-x" style={{ width: `${Math.max(4, (score / max) * 100)}%` }} />
    </span>
  );
}
