import { useMemo } from "react";
import { formatDuration, formatTime, generateDay, validate, withTimes, type PlannerSettings, type TaskInput } from "../../schedule";

// Live preview of the form values. Display only: it calls the planner's own scheduling functions
// with the values already in state and never changes them. The shift-review rules are applied only
// when the draft is generated, so they aren't part of this preview.

const PATTERN_TASK = "Work";

export function PlanPreview({ settings, tasks, perDay }: { settings: PlannerSettings; tasks: TaskInput[]; perDay: boolean }) {
  const shiftMin = settings.endMin - settings.startMin;
  const shiftOk = Number.isFinite(shiftMin) && shiftMin > 0;

  const preview = useMemo(() => {
    // The planner's own validation first: with invalid shift or break values the scheduler can't run.
    const pattern: TaskInput[] = [{ id: "preview-pattern", name: PATTERN_TASK, minutes: shiftOk ? shiftMin : 0, demanding: false }];
    if (validate(settings, pattern).length) return null;
    const day = generateDay("preview", settings, tasks);
    const rhythm = generateDay("pattern", settings, pattern);
    const sum = (kinds: string[]) => day.blocks.filter((b) => kinds.includes(b.kind)).reduce((a, b) => a + b.minutes, 0);
    return {
      taskMin: sum(["task"]), breakMin: sum(["break", "meal"]), openMin: sum(["open"]),
      overMin: day.unscheduled.reduce((a, u) => a + u.minutes, 0),
      rhythm: withTimes(rhythm.blocks, settings.startMin),
    };
  }, [settings.startMin, settings.endMin, settings.shortBreakMin, settings.workStretchMin, settings.mealBreakMin, settings.alternate, tasks, shiftOk, shiftMin]); // eslint-disable-line react-hooks/exhaustive-deps

  const enteredMin = tasks.reduce((a, t) => a + (t.name.trim() ? t.minutes || 0 : 0), 0);
  const total = shiftOk ? shiftMin : 1;

  return (
    <section className="plan-preview mo-lift" aria-label="Preview">
      <div className="plan-preview-head">
        <span className="eyebrow">Preview{perDay ? " · each work day" : ""}</span>
        <span className="pp-note">Uses your break rules. Shift-review rules apply when you generate.</span>
      </div>

      <div className="pp-top">
        <div className="pp-shift">
          <span className="pp-big">{shiftOk ? formatDuration(shiftMin) : "–"}</span>
          <span className="pp-range">{shiftOk ? `${formatTime(settings.startMin)}–${formatTime(settings.endMin)}` : "Set a start and end time"}</span>
        </div>
        {preview && (
          <dl className="pp-legend">
            <div><dt><span className="pp-key task" aria-hidden="true" />Tasks</dt><dd>{formatDuration(preview.taskMin)}</dd></div>
            <div><dt><span className="pp-key break" aria-hidden="true" />Breaks</dt><dd>{formatDuration(preview.breakMin)}</dd></div>
            <div><dt><span className="pp-key open" aria-hidden="true" />Unused</dt><dd>{formatDuration(preview.openMin)}</dd></div>
          </dl>
        )}
      </div>

      {preview ? (
        <>
          <div className="pp-bar mo-grow-x" role="img"
            aria-label={`Shift ${formatDuration(shiftMin)}: tasks ${formatDuration(preview.taskMin)}, breaks ${formatDuration(preview.breakMin)}, unused ${formatDuration(preview.openMin)}`}>
            {preview.taskMin > 0 && <span className="pp-seg task" style={{ flexGrow: preview.taskMin / total }} />}
            {preview.breakMin > 0 && <span className="pp-seg break" style={{ flexGrow: preview.breakMin / total }} />}
            {preview.openMin > 0 && <span className="pp-seg open" style={{ flexGrow: preview.openMin / total }} />}
          </div>
          {preview.overMin > 0 && (
            <p className="pp-over" role="status">Tasks are {formatDuration(preview.overMin)} over the shift with these breaks.</p>
          )}

          <div className="pp-rhythm">
            <span className="pp-label">Work and break pattern</span>
            <div className="pp-strip mo-grow-x mo-delay-1" aria-hidden="true">
              {preview.rhythm.map((b) => (
                <span key={b.id} className={`pp-seg ${b.kind === "task" ? "task" : b.kind === "open" ? "open" : "break"}`}
                  style={{ flexGrow: b.minutes / total }}
                  title={`${b.kind === "task" ? "Work" : b.kind === "meal" ? "Meal break" : b.kind === "open" ? "Open time" : "Break"} · ${formatTime(b.start)}–${formatTime(b.end)} (${formatDuration(b.minutes)})`} />
              ))}
            </div>
            <p className="pp-caption">
              Work {settings.workStretchMin} min · Break {settings.shortBreakMin} min
              {settings.mealBreakMin > 0 ? ` · Meal break ${settings.mealBreakMin} min, mid-shift` : " · No meal break"}
            </p>
          </div>
        </>
      ) : (
        <p className="pp-paused">
          {formatDuration(enteredMin)} of tasks entered. The full preview appears once the shift and break values are valid.
        </p>
      )}
    </section>
  );
}
