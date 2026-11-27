import { useState, type ReactNode } from "react";
import { dayTotals, DAY_NAMES, formatDuration, formatTime, withTimes, WEEK_DAYS, type Block, type BlockKind, type PlannerSettings } from "../../schedule";

// Display-only views of a day's blocks. They read the blocks and settings as they are, using the
// planner's own helpers (withTimes, dayTotals); nothing here changes the plan.

export const KIND_NAME: Record<BlockKind, string> = { task: "Work", break: "Break", meal: "Meal break", open: "Open time" };
const segKind = (k: BlockKind) => (k === "meal" ? "break meal" : k);

/** Donut, three large numbers and the shift time range. */
export function DaySummary({ blocks, settings }: { blocks: Block[]; settings: Pick<PlannerSettings, "startMin" | "endMin"> }) {
  const tot = dayTotals(blocks, settings);
  const workBlocks = blocks.filter((b) => b.kind === "task").length;
  const all = tot.taskMin + tot.breakMin + tot.openMin || 1;
  const r = 20, c = 2 * Math.PI * r;
  const taskLen = (tot.taskMin / all) * c, breakLen = (tot.breakMin / all) * c;
  return (
    <div className="day-summary mo-lift mo-fade-up">
      <svg className="donut mo-ring" width="84" height="84" viewBox="0 0 48 48" aria-hidden="true">
        <circle className="donut-track" cx="24" cy="24" r={r} />
        <circle className="donut-task" cx="24" cy="24" r={r} strokeDasharray={`${taskLen} ${c}`} transform="rotate(-90 24 24)" />
        <circle className="donut-break" cx="24" cy="24" r={r} strokeDasharray={`${breakLen} ${c}`} strokeDashoffset={-taskLen} transform="rotate(-90 24 24)" />
      </svg>
      <dl className="day-numbers">
        <div><dt><span className="pp-key task" aria-hidden="true" />Tasks</dt><dd>{formatDuration(tot.taskMin)}</dd></div>
        <div><dt><span className="pp-key break" aria-hidden="true" />Breaks</dt><dd>{formatDuration(tot.breakMin)}</dd></div>
        <div><dt>Work blocks</dt><dd>{workBlocks}</dd></div>
      </dl>
      <div className="day-range">
        <span className="pp-label">Shift</span>
        <span className="day-range-time">{formatTime(settings.startMin)}–{formatTime(settings.endMin)}</span>
      </div>
    </div>
  );
}

/** The day as a tall timeline with hour labels; hovering a segment reports its block id. */
export function DayTimeline({ blocks, settings, hover, onHover }: {
  blocks: Block[]; settings: Pick<PlannerSettings, "startMin" | "endMin">; hover: string | null; onHover: (id: string | null) => void;
}) {
  const timed = withTimes(blocks, settings.startMin);
  const start = settings.startMin;
  const end = Math.max(settings.endMin, timed.length ? timed[timed.length - 1].end : settings.endMin);
  const span = end - start || 1;
  const firstHour = Math.ceil(start / 60);
  const hours: number[] = [];
  for (let h = firstHour; h * 60 <= end; h += 2) hours.push(h);
  const shown = timed.find((b) => b.id === hover) ?? null;
  return (
    <div className="day-timeline">
      <div className="dt-track mo-grow-x" aria-hidden="true">
        {timed.map((b) => (
          <span key={b.id} className={`dt-seg ${segKind(b.kind)} ${b.demanding ? "demanding" : ""} ${hover === b.id ? "hover" : ""}`}
            style={{ left: `${((b.start - start) / span) * 100}%`, width: `${(b.minutes / span) * 100}%` }}
            onMouseEnter={() => onHover(b.id)} onMouseLeave={() => onHover(null)} />
        ))}
        {settings.endMin < end && <span className="dt-shift-end" style={{ left: `${((settings.endMin - start) / span) * 100}%` }} />}
      </div>
      <div className="dt-hours" aria-hidden="true">
        {hours.map((h) => (
          <span key={h} style={{ left: `${((h * 60 - start) / span) * 100}%` }}>{String(h % 24).padStart(2, "0")}</span>
        ))}
      </div>
      <p className="dt-caption" aria-live="polite">
        {shown ? <><strong>{shown.label}</strong> · {formatTime(shown.start)}–{formatTime(shown.end)} ({formatDuration(shown.minutes)})</> : "Hover a segment or a row to see its time"}
      </p>
    </div>
  );
}

/**
 * Seven columns, Mon to Sun, with a time axis on the left. A selected day shows its blocks stacked
 * top to bottom; an unselected day is an empty dashed "Off" column.
 */
export function WeekCalendar({ plans, startMin, endMin, header, onOpen, current }: {
  plans: Record<string, Block[] | undefined>;          // blocks per selected day; missing = off
  startMin: number; endMin: number;
  header: (day: string) => ReactNode;                 // the column header (a day toggle or a label)
  onOpen?: (day: string) => void;                     // open a day's detailed list
  current?: string | null;
}) {
  const [tip, setTip] = useState<string | null>(null);   // display only: the hovered block's description
  const ends = Object.values(plans).flatMap((bs) => (bs ? [startMin + bs.reduce((a, b) => a + b.minutes, 0)] : []));
  const end = Math.max(endMin, ...ends);
  const span = end - startMin || 1;
  const hours: number[] = [];
  for (let h = Math.ceil(startMin / 60); h * 60 <= end; h++) hours.push(h);
  return (
    <div className="week-cal" role="group" aria-label="Week calendar">
      <div className="wc-grid">
        <div className="wc-axis" aria-hidden="true">
          <div className="wc-head-spacer" />
          <div className="wc-axis-body">
            {hours.map((h) => (
              <span key={h} style={{ top: `${((h * 60 - startMin) / span) * 100}%` }}>{String(h % 24).padStart(2, "0")}:00</span>
            ))}
          </div>
        </div>
        {WEEK_DAYS.map((d) => {
          const bs = plans[d];
          return (
            <div key={d} className={`wc-col ${bs ? "on" : "off"} ${current === d ? "current" : ""}`}>
              <div className="wc-head">{header(d)}</div>
              {bs ? (
                <div className={`wc-body ${onOpen ? "clickable" : ""}`} onClick={onOpen ? () => onOpen(d) : undefined}
                  role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined}
                  aria-label={onOpen ? `Open ${DAY_NAMES[d]}` : undefined}
                  onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(d); } } : undefined}>
                  {hours.map((h) => <span key={h} className="wc-line" style={{ top: `${((h * 60 - startMin) / span) * 100}%` }} aria-hidden="true" />)}
                  {withTimes(bs, startMin).map((b, i) => {
                    const text = `${DAY_NAMES[d]} · ${KIND_NAME[b.kind]}${b.kind === "task" ? `: ${b.label}` : ""} · ${formatTime(b.start)}–${formatTime(b.end)}`;
                    return (
                      <span key={b.id} className={`wc-block ${segKind(b.kind)} ${b.demanding ? "demanding" : ""} ${tip === text ? "hover" : ""}`}
                        style={{ top: `${((b.start - startMin) / span) * 100}%`, height: `${(b.minutes / span) * 100}%`, animationDelay: `${i * 40}ms` }}
                        title={text} onMouseEnter={() => setTip(text)} onMouseLeave={() => setTip(null)}>
                        <span className="wc-block-label">{b.kind === "task" ? b.label : KIND_NAME[b.kind]}</span>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="wc-body wc-off"><span>Off</span></div>
              )}
            </div>
          );
        })}
      </div>
      <p className="dt-caption wc-caption" aria-live="polite">{tip ?? "Hover a block to see its day, type and time"}</p>
    </div>
  );
}
