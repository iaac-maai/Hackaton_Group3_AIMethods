import type { ReactNode } from "react";

// Extra controls for the planner form. Each one calls the same setter the existing input uses, with
// the same kind of value; the existing inputs stay on the page.

/** − and + buttons around an existing number input. */
export function Stepper({ value, min, max, step, label, onChange, children }: {
  value: number; min: number; max: number; step: number; label: string; onChange: (v: number) => void; children: ReactNode;
}) {
  const v = Number.isFinite(value) ? value : 0;
  return (
    <span className="stepper">
      <button type="button" className="stepper-btn" aria-label={`Decrease ${label}`} disabled={v <= min}
        onClick={() => onChange(Math.max(min, v - step))}>−</button>
      {children}
      <button type="button" className="stepper-btn" aria-label={`Increase ${label}`} disabled={v >= max}
        onClick={() => onChange(Math.min(max, v + step))}>+</button>
    </span>
  );
}

/** A range slider for a minutes value. */
export function MinutesSlider({ value, min, max, step, label, disabled, onChange }: {
  value: number | ""; min: number; max: number; step: number; label: string; disabled?: boolean; onChange: (v: string) => void;
}) {
  const v = typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  const fill = ((v - min) / (max - min)) * 100;
  return (
    <span className="range-wrap">
      <input type="range" className="range" min={min} max={max} step={step} value={v} disabled={disabled}
        aria-label={label} style={{ ["--fill" as string]: `${fill}%` }} onChange={(e) => onChange(e.target.value)} />
      <span className="range-ends" aria-hidden="true"><span>{min}</span><span>{max}</span></span>
    </span>
  );
}

/** Quick-pick chips for common durations. */
export function QuickChips({ values, current, label, onPick }: { values: number[]; current: number; label: string; onPick: (v: number) => void }) {
  return (
    <span className="quick-chips" role="group" aria-label={label}>
      {values.map((m) => (
        <button key={m} type="button" className={`quick-chip ${current === m ? "on" : ""}`} aria-pressed={current === m} onClick={() => onPick(m)}>
          {m} min
        </button>
      ))}
    </span>
  );
}
