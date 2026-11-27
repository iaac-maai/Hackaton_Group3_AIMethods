import type { HistoryItem } from "../history";
import { InfoTip } from "./ui/InfoTip";
import { WindowCount } from "./ui/WindowCount";

// Recent saved analyses in the team's shared History. Selecting a row restores its summary and timeline.

export type HistoryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: HistoryItem[] };

interface Props {
  state: HistoryState;
  selectedId: string | null;
  busyId: string | null;          // row being opened or deleted
  actionError: string | null;     // last open/delete error
  onSelect: (item: HistoryItem) => void;
  onDelete: (item: HistoryItem) => void;
  onRetry: () => void;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function HistoryPanel({ state, selectedId, busyId, actionError, onSelect, onDelete, onRetry }: Props) {
  return (
    <section className="history" id="history" aria-labelledby="history-title">
      <div className="history-head">
        <h2 id="history-title">History</h2>
        <InfoTip label="About History">
          <p>
            Recent analyses in the team’s shared History (summaries and window scores only, no video or keypoints).
            Everyone who logs in with the team password can see, open and delete them. This is a prototype, so don’t
            analyse confidential footage.
          </p>
        </InfoTip>
      </div>
      {state.kind === "loading" && <p role="status">Loading saved analyses…</p>}
      {state.kind === "error" && (
        <div className="error-box" role="alert">
          <p>Could not load history: {state.message}</p>
          <button onClick={onRetry}>Try again</button>
        </div>
      )}
      {state.kind === "ready" && state.items.length === 0 && (
        <p className="muted">No saved analyses yet. Each successful single-person analysis is saved here automatically.</p>
      )}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {state.kind === "ready" && state.items.length > 0 && (
        <ul className="history-list">
          {state.items.map((item) => (
            <li key={item.id} className={`history-card mo-lift mo-fade-up ${item.id === selectedId ? "selected" : ""}`}>
              <button className="history-open" aria-pressed={item.id === selectedId} disabled={busyId === item.id}
                onClick={() => onSelect(item)}>
                <span className="history-date">{dateFmt.format(new Date(item.created_at))}</span>
                <span>{item.label}</span>
                <span className="muted">{item.duration_seconds != null ? `${item.duration_seconds.toFixed(1)} s` : "duration —"}</span>
                <span className="muted history-count">
                  {item.flagged_count} of {item.window_count} windows flagged ({item.flagged_percent.toFixed(0)}%)
                </span>
                <WindowCount total={item.window_count} flagged={item.flagged_count} />
              </button>
              <button className="history-delete" disabled={busyId === item.id}
                aria-label={`Delete the analysis from ${dateFmt.format(new Date(item.created_at))}`}
                onClick={() => onDelete(item)}>
                {busyId === item.id ? "…" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
