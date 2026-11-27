import { useEffect, useId, useMemo, useRef, useState } from "react";
import { groupWorkers, planFromReview, type ReviewClip, type ReviewEntry } from "../review";
import {
  addBlock, dayTotals, DAY_NAMES, EXERTION_LABEL, formatDuration, formatTime, generatePlan, moveBlock, newId, parseTime, planToText,
  removeBlock, updateBlock, validate, WEEK_DAYS, withTimes, type Block, type BlockKind, type DayPlan, type PlannerSettings,
  type TaskInput,
} from "../schedule";
import { emptyEntry, ShiftReview } from "./ShiftReview";
import { PlanPreview } from "./planner/PlanPreview";
import { MinutesSlider, QuickChips, Stepper } from "./planner/Controls";
import { DaySummary, DayTimeline, WeekCalendar } from "./planner/DayViews";
import {
  IconAlert, IconCheck, IconCheckShield, IconClock, IconCoffee, IconCopy, IconDownload, IconFlame, IconInfo, IconList, IconMeal,
  IconRepeat, IconScale, IconTrash, IconX,
} from "./ui/Icons";
import { InfoTip } from "./ui/InfoTip";

// Draft schedule planner. Everything stays in this page's memory: nothing is saved to History,
// stored in the browser, or sent anywhere. Suggestions follow only the user's inputs: shift, tasks,
// break rules and, from the shift review, the worker's own exertion/tiredness ratings.

/** What a draft is based on, shown with it and in the export. */
interface DraftBasis { personalized: boolean; title: string; notes: string[] }

// Starting values for the two shift-review rules. Editable planning assumptions chosen for this
// prototype, not validated recovery guidance or legal requirements.
const RULE_DEFAULT_MIN = 60;
const RULE_MIN = 15, RULE_MAX = 480;

/** A rule's minutes are valid when it is off, or a whole number of minutes in range. */
const ruleError = (on: boolean, v: number | "", what: string) =>
  on && !(typeof v === "number" && Number.isInteger(v) && v >= RULE_MIN && v <= RULE_MAX)
    ? `Set ${what} to a whole number between ${RULE_MIN} and ${RULE_MAX} minutes, or turn that rule off.` : null;
const TEMPLATE_TASK = "Work block (assign a task)";

const KIND_LABEL: Record<BlockKind, string> = { task: "Task", break: "Break", meal: "Meal break", open: "Open time" };

export function SchedulePlanner({ reviewClips, onRemoveClip, onGoToAnalysis }: {
  reviewClips: ReviewClip[]; onRemoveClip: (id: string) => void; onGoToAnalysis?: () => void;
}) {
  const uid = useId();
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [basisKey, setBasisKey] = useState("");
  const [mode, setMode] = useState<"day" | "week">("day");
  const [start, setStart] = useState("07:00");
  const [end, setEnd] = useState("15:30");
  const [days, setDays] = useState<string[]>(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  const [tasks, setTasks] = useState<TaskInput[]>([{ id: newId("t"), name: "", minutes: 60, demanding: false }]);
  const [shortBreak, setShortBreak] = useState(10);
  const [stretch, setStretch] = useState(90);
  const [meal, setMeal] = useState(30);
  const [alternate, setAlternate] = useState(true);
  const [hardOn, setHardOn] = useState(true);
  const [hardMin, setHardMin] = useState<number | "">(RULE_DEFAULT_MIN);
  const [tiredOn, setTiredOn] = useState(true);
  const [tiredMin, setTiredMin] = useState<number | "">(RULE_DEFAULT_MIN);
  const [plan, setPlan] = useState<{ settings: PlannerSettings; days: DayPlan[]; basis: DraftBasis } | null>(null);
  const [edited, setEdited] = useState(false);
  const [current, setCurrent] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [copyText, setCopyText] = useState<string | null>(null);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null>(null);

  const settings: PlannerSettings = {
    startMin: parseTime(start) ?? NaN, endMin: parseTime(end) ?? NaN,
    shortBreakMin: shortBreak, workStretchMin: stretch, mealBreakMin: meal, alternate,
  };
  const dayList = mode === "day" ? ["Day"] : WEEK_DAYS.filter((d) => days.includes(d));

  // Keep one review entry per newly added clip; drop entries of removed clips.
  useEffect(() => {
    setEntries((es) => {
      const kept = es.filter((e) => reviewClips.some((c) => c.id === e.clipId));
      const added = reviewClips.filter((c) => !kept.some((e) => e.clipId === c.id)).map(emptyEntry);
      return added.length || kept.length !== es.length ? [...kept, ...added] : es;
    });
  }, [reviewClips]);
  const groups = useMemo(() => groupWorkers(entries), [entries]);
  const group = groups.find((g) => g.key === basisKey) ?? null;
  useEffect(() => { if (basisKey && !group) setBasisKey(""); }, [basisKey, group]);
  const reviewPlan = useMemo(() => (group ? planFromReview(group, reviewClips, confirmed, () => newId("t")) : null), [group, reviewClips, confirmed]);

  function fillFromReview() {
    if (!reviewPlan?.tasks.length) return;
    if (tasks.some((t) => t.name.trim()) && !window.confirm("Replace the tasks below with the tasks from the shift review?")) return;
    setTasks(reviewPlan.tasks.map((t) => ({ ...t })));
    setStatus(`Tasks filled from the shift review for ${group!.name}. Check them, then generate the draft.`);
  }

  function generate() {
    const hasTasks = tasks.some((t) => t.name.trim() && t.minutes > 0);
    const reviewTaskNames = new Set(reviewPlan?.tasks.map((t) => t.name.trim().toLowerCase()) ?? []);
    const usesReviewTasks = tasks.some((t) => reviewTaskNames.has(t.name.trim().toLowerCase()));
    // Review rules apply only when the review has enough information and its tasks are in the list;
    // otherwise this is a general template.
    const personal = reviewPlan?.personalized === true && usesReviewTasks;
    const shiftMin = settings.endMin - settings.startMin;
    // With no tasks entered, the general template fills the shift with placeholder work blocks.
    const planTasks: TaskInput[] = hasTasks ? tasks
      : [{ id: "template", name: TEMPLATE_TASK, minutes: Number.isFinite(shiftMin) ? Math.max(0, shiftMin) : 0, demanding: false }];
    const errs = validate(settings, planTasks);
    for (const e of [ruleError(hardOn, hardMin, "the maximum stretch for tasks rated Hard"), ruleError(tiredOn, tiredMin, "the work interval after reported tiredness")]) {
      if (e) errs.push(e);
    }
    if (mode === "week" && dayList.length === 0) errs.push("Choose at least one work day.");
    setErrors(errs);
    if (errs.length) { setStatus(""); return; }
    if (plan && edited && !window.confirm("Generate a new draft? This replaces the changes you made to the current draft.")) return;
    // The two shift-review rules apply only to a personalised draft, and only when the user leaves them on.
    const tiredApplies = personal && tiredOn && reviewPlan!.tiredFromMin != null;
    const used: PlannerSettings = personal ? {
      ...settings,
      hardStretchMin: hardOn && reviewPlan!.hasHardTask && tasks.some((t) => t.exertion) ? (hardMin as number) : undefined,
      tiredFromMin: tiredApplies ? reviewPlan!.tiredFromMin! : undefined,
      tiredStretchMin: tiredApplies ? (tiredMin as number) : undefined,
    } : settings;
    const basis: DraftBasis = personal
      ? { personalized: true, title: `${mode === "day" ? "Next-day draft" : "Draft"} for ${group!.name}, based on the shift review`,
          notes: [...reviewPlan!.basis, ...ruleNotes(), ...reviewPlan!.gaps] }
      : { personalized: false, title: "General schedule template (not personalised)",
          notes: [
            ...(reviewPlan && !reviewPlan.personalized ? ["Not based on the shift review. Missing:", ...reviewPlan.missing]
              : reviewPlan ? ["Not based on the shift review: the tasks below don’t come from it. Use “Fill the tasks below from the review” first."]
              : ["Based only on the shift and break settings entered here; no shift review was used."]),
            ...(hasTasks ? [] : ["No tasks entered, so the template shows placeholder work blocks to fill in."]),
          ] };
    const days = generatePlan(dayList, used, planTasks).map((d) => ({
      ...d,
      blocks: d.blocks.map((b) => (b.kind === "task" && b.label.startsWith(TEMPLATE_TASK)
        ? { ...b, reason: "Placeholder work time from the general template. Assign a task here." } : b)),
    }));
    setPlan({ settings: used, days, basis });
    setEdited(false); setCurrent(0); setCopyText(null);
    setStatus(`Draft created for ${dayList.length === 1 ? DAY_NAMES[dayList[0]].toLowerCase() : `${dayList.length} days`}. Review and edit it below.`);
    requestAnimationFrame(() => draftHeading.current?.focus());
  }

  function editDay(i: number, fn: (b: Block[]) => Block[]) {
    setPlan((p) => p && { ...p, days: p.days.map((d, j) => (j === i ? { ...d, blocks: fn(d.blocks) } : d)) });
    setEdited(true);
  }

  function discard() {
    if (edited && !window.confirm("Discard this draft and your changes to it?")) return;
    setPlan(null); setEdited(false); setCopyText(null); setStatus("Draft discarded.");
  }

  async function copy() {
    if (!plan) return;
    const text = planToText(plan.days, plan.settings, plan.basis);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Draft copied as text. Paste it wherever you need it.");
      setCopyText(null);
    } catch {
      setCopyText(text);
      setStatus("Copying isn’t available here; the text is shown below to select and copy.");
    }
  }

  /** The user-selected rules, stated with the draft and in the export. */
  function ruleNotes(): string[] {
    const notes: string[] = [];
    const noEffect = (m: number) => (m >= stretch ? ` It isn’t shorter than your general break interval (${stretch} min), so it doesn’t change the draft.` : "");
    if (!hardOn) notes.push("Rule for tasks rated Hard or Very hard: off.");
    else if (!reviewPlan?.hasHardTask) notes.push(`Rule for tasks rated Hard or Very hard: at most ${hardMin} min of continuous work. No task was rated Hard, so it wasn’t used.`);
    else notes.push(`Rule for tasks rated Hard or Very hard: at most ${hardMin} min of continuous work (your planning assumption).${noEffect(hardMin as number)}`);
    if (!tiredOn) notes.push("Rule after reported tiredness: off.");
    else if (reviewPlan?.tiredFromMin == null) notes.push(`Rule after reported tiredness: a break every ${tiredMin} min of work. No tiredness was reported with a time, so it wasn’t used.`);
    else notes.push(`Rule after reported tiredness: a break every ${tiredMin} min of work from ${formatTime(reviewPlan.tiredFromMin)} (your planning assumption).${noEffect(tiredMin as number)}`);
    return notes;
  }

  function download() {
    if (!plan) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([planToText(plan.days, plan.settings, plan.basis)], { type: "text/plain" }));
    a.download = "schedule-draft.txt";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Draft downloaded as a text file.");
  }

  const setTask = (id: string, patch: Partial<TaskInput>) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const taskTotal = tasks.reduce((a, t) => a + (t.name.trim() ? t.minutes || 0 : 0), 0);
  const shiftLen = Number.isFinite(settings.endMin - settings.startMin) ? settings.endMin - settings.startMin : 0;
  const day = plan?.days[current] ?? null;

  // ---- Display only (no effect on the plan): week preview, sticky Generate bar, button pulse ----
  const formId = `${uid}-form`;
  const formRef = useRef<HTMLFormElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const [stickyOn, setStickyOn] = useState(false);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const f = formRef.current, b = ctaRef.current;
    if (!f || !b || typeof IntersectionObserver === "undefined") return;
    let formIn = false, btnIn = true;
    const io = new IntersectionObserver((es) => {
      for (const e of es) { if (e.target === f) formIn = e.isIntersecting; else btnIn = e.isIntersecting; }
      setStickyOn(formIn && !btnIn);
    });
    io.observe(f); io.observe(b);
    return () => io.disconnect();
  }, []);
  // Week preview: the planner's own generatePlan on the current values (general break rules only),
  // run only when its own validation passes.
  const weekPreview = useMemo(() => {
    if (mode !== "week") return null;
    const len = settings.endMin - settings.startMin;
    const pattern: TaskInput[] = [{ id: "preview-pattern", name: "Work", minutes: Number.isFinite(len) && len > 0 ? len : 0, demanding: false }];
    if (validate(settings, pattern).length) return { ok: false as const, plans: Object.fromEntries(dayList.map((d) => [d, [] as Block[]])) };
    const plans: Record<string, Block[]> = {};
    for (const d of generatePlan(dayList, settings, tasks)) plans[d.day] = d.blocks;
    return { ok: true as const, plans };
  }, [mode, start, end, shortBreak, stretch, meal, alternate, tasks, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekTaskMin = weekPreview?.ok ? Object.values(weekPreview.plans).reduce((a, bs) => a + dayTotals(bs, settings).taskMin, 0) : 0;
  const toggleDayFromCalendar = (d: string, checked: boolean) => setDays((ds) => (checked ? [...ds, d] : ds.filter((x) => x !== d)));
  const draftPlans: Record<string, Block[]> = plan ? Object.fromEntries(plan.days.map((d) => [d.day, d.blocks])) : {};

  return (
    <div className="planner">
      <div className="planner-intro mo-fade-up">
        <span className="eyebrow">Planner · draft only</span>
        <h2 className="planner-title">Draft a next-day plan</h2>
        <ol className="plan-steps" aria-label="Steps">
          <li><span className="step-num">1</span>Shift</li>
          <li><span className="step-num">2</span>Tasks</li>
          <li><span className="step-num">3</span>Breaks</li>
          <li><span className="step-num">4</span>Generate</li>
        </ol>
        <ul className="chip-row intro-tags" aria-label="About this planner">
          <li className="chip-tag">Draft only</li>
          <li className="chip-tag">Stays on this page</li>
          <li className="chip-tag">Not medical advice</li>
        </ul>
        <details className="details-tag">
          <summary>Details</summary>
          <p className="muted">
            Enter the shift, the tasks and your break rules. Optionally add a shift review, built from analysed clips plus the worker’s own
            ratings, to tailor task rotation and breaks. Every suggestion says why it was made, and you can change or remove anything.
            It’s a draft for the worker and supervisor to review, not medical advice or a safety assessment.
            It stays on this page: it isn’t saved, shared or sent anywhere, and reloading the page clears it.
          </p>
        </details>
      </div>

      <ShiftReview clips={reviewClips} entries={entries} onEntries={setEntries} confirmed={confirmed}
        onConfirm={(sig, ok) => setConfirmed((c) => { const n = new Set(c); if (ok) n.add(sig); else n.delete(sig); return n; })}
        basis={basisKey} onBasis={setBasisKey} plan={reviewPlan} onFill={fillFromReview} onRemoveClip={onRemoveClip}
        onGoToAnalysis={onGoToAnalysis} />

      <form id={formId} ref={formRef} className="card planner-form" onSubmit={(e) => { e.preventDefault(); generate(); }} noValidate>
        <PlanPreview settings={settings} tasks={tasks} perDay={mode === "week"} />
        <fieldset className="field-group">
          <legend>Plan for</legend>
          <div className="segmented">
            {(["day", "week"] as const).map((m) => (
              <label key={m} className={`segment ${mode === m ? "on" : ""}`}>
                <input type="radio" name={`${uid}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} />
                {m === "day" ? "One day" : "One week"}
              </label>
            ))}
          </div>
          {mode === "week" && (
            <div className="day-picks" role="group" aria-label="Work days">
              {WEEK_DAYS.map((d) => (
                <label key={d} className={`chip ${days.includes(d) ? "on" : ""}`}>
                  <input type="checkbox" checked={days.includes(d)}
                    onChange={(e) => setDays((ds) => (e.target.checked ? [...ds, d] : ds.filter((x) => x !== d)))} />
                  <span aria-hidden="true">{d}</span><span className="sr-only">{DAY_NAMES[d]}</span>
                </label>
              ))}
            </div>
          )}
          {mode === "week" && weekPreview && (
            <div className="week-preview mo-fade-up">
              <div className="wp-head">
                <span className="eyebrow">Week preview</span>
                <span className="wp-stats">
                  <strong>{dayList.length}</strong> work day{dayList.length === 1 ? "" : "s"}
                  {weekPreview.ok && <> · <strong>{formatDuration(weekTaskMin)}</strong> of tasks</>}
                </span>
              </div>
              {!weekPreview.ok && <p className="pp-paused">The calendar fills in once the shift and break values are valid.</p>}
              <WeekCalendar plans={weekPreview.plans} startMin={Number.isFinite(settings.startMin) ? settings.startMin : 0}
                endMin={Number.isFinite(settings.endMin) && settings.endMin > settings.startMin ? settings.endMin : (Number.isFinite(settings.startMin) ? settings.startMin + 60 : 60)}
                header={(d) => (
                  <button type="button" className={`wc-day ${days.includes(d) ? "on" : ""}`} aria-pressed={days.includes(d)}
                    onClick={() => toggleDayFromCalendar(d, !days.includes(d))}>
                    <span aria-hidden="true">{d}</span><span className="sr-only">{DAY_NAMES[d]}</span>
                  </button>
                )} />
            </div>
          )}
        </fieldset>

        <fieldset className="field-group form-card mo-lift">
          <legend><span className="legend-icon"><IconClock size={18} /></span>Shift{mode === "week" ? " (same each work day)" : ""}</legend>
          <div className="field-row">
            <label className="field"><span>Starts</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
            <label className="field"><span>Ends</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
            <p className="field-note muted">{shiftLen > 0 ? `${formatDuration(shiftLen)} shift` : ""}</p>
          </div>
          <ShiftDayBar startMin={settings.startMin} endMin={settings.endMin} />
        </fieldset>

        <fieldset className="field-group form-card mo-lift">
          <legend><span className="legend-icon"><IconList /></span>Tasks{mode === "week" ? " (each work day)" : ""}</legend>
          <ol className="task-inputs">
            {tasks.map((t, i) => (
              <li key={t.id} className="task-card mo-lift mo-fade-up">
                <label className="field grow"><span>Task {i + 1}</span>
                  <input type="text" value={t.name} placeholder="e.g. Rebar tying" onChange={(e) => setTask(t.id, { name: e.target.value })} />
                </label>
                <label className="field narrow"><span>Minutes</span>
                  <input type="number" inputMode="numeric" min={5} max={720} step={5} value={t.minutes}
                    onChange={(e) => setTask(t.id, { minutes: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label className={`chip demand-chip ${t.demanding ? "on" : ""}`}>
                  <input type="checkbox" checked={t.demanding} onChange={(e) => setTask(t.id, { demanding: e.target.checked })} />
                  <IconFlame />Physically demanding</label>
                {t.exertion && <span className="tag" title="The worker’s own rating, from the shift review">Rated {EXERTION_LABEL[t.exertion]}</span>}
                <button type="button" className="icon-btn" aria-label={`Remove task ${i + 1}${t.name ? `, ${t.name}` : ""}`}
                  disabled={tasks.length === 1} onClick={() => setTasks((ts) => ts.filter((x) => x.id !== t.id))}>✕</button>
                <div className="task-quick">
                  <MinutesSlider value={t.minutes} min={5} max={720} step={5} label={`Minutes for task ${i + 1}`}
                    onChange={(v) => setTask(t.id, { minutes: Math.max(0, Number(v) || 0) })} />
                  <QuickChips values={[30, 60, 90]} current={t.minutes} label={`Quick durations for task ${i + 1}`}
                    onPick={(m) => setTask(t.id, { minutes: m })} />
                </div>
              </li>
            ))}
          </ol>
          <div className="field-row">
            <button type="button" onClick={() => setTasks((ts) => [...ts, { id: newId("t"), name: "", minutes: 60, demanding: false }])}>+ Add task</button>
            <p className="field-note muted task-total">
              {formatDuration(taskTotal)} of tasks{shiftLen > 0 ? ` for a ${formatDuration(shiftLen)} shift` : ""}
              {shiftLen > 0 && (
                <span className="thin-progress" aria-hidden="true">
                  <span className="mo-grow-x" style={{ width: `${Math.min(100, (taskTotal / shiftLen) * 100)}%` }} />
                </span>
              )}
            </p>
          </div>
        </fieldset>

        <fieldset className="field-group form-card mo-lift">
          <legend><span className="legend-icon"><IconCoffee /></span>Breaks</legend>
          <div className="field-row">
            <div className="field narrow"><label htmlFor={`${uid}-short`}><IconCoffee size={15} /> Short break (min)</label>
              <Stepper value={shortBreak} min={0} max={60} step={5} label="short break" onChange={setShortBreak}>
                <input id={`${uid}-short`} type="number" min={0} max={60} step={5} value={shortBreak} onChange={(e) => setShortBreak(Number(e.target.value) || 0)} />
              </Stepper></div>
            <div className="field narrow"><label htmlFor={`${uid}-stretch`}><IconRepeat size={15} /> After every (min of work)</label>
              <Stepper value={stretch} min={15} max={480} step={5} label="work between breaks" onChange={setStretch}>
                <input id={`${uid}-stretch`} type="number" min={15} max={480} step={5} value={stretch} onChange={(e) => setStretch(Number(e.target.value) || 0)} />
              </Stepper></div>
            <div className="field narrow"><label htmlFor={`${uid}-meal`}><IconMeal size={15} /> Meal break (min, 0 = none)</label>
              <Stepper value={meal} min={0} max={120} step={5} label="meal break" onChange={setMeal}>
                <input id={`${uid}-meal`} type="number" min={0} max={120} step={5} value={meal} onChange={(e) => setMeal(Number(e.target.value) || 0)} />
              </Stepper></div>
          </div>
          <label className="check switch-check"><input type="checkbox" checked={alternate} onChange={(e) => setAlternate(e.target.checked)} />
            Alternate physically demanding and lighter tasks where possible</label>
        </fieldset>

        <fieldset className="field-group form-card rules mo-lift">
          <legend><span className="legend-icon"><IconScale /></span>Rules for the worker’s own ratings (shift review)</legend>
          <InfoTip label="About these rules" className="rules-info">
            <p className="field-note" id={`${uid}-rules-note`}>
              Used only when the draft is based on a shift review that includes these ratings. The starting values of {RULE_DEFAULT_MIN} min are
              editable planning assumptions, not validated recovery guidance or legal requirements. Agree them with the worker or supervisor,
              and turn off any rule that doesn’t apply.
            </p>
          </InfoTip>
          <RuleRow id={`${uid}-hard`} on={hardOn} onToggle={setHardOn} value={hardMin} onValue={setHardMin} stretch={stretch}
            toggleLabel="Limit continuous work on tasks rated Hard or Very hard" fieldLabel="Maximum continuous stretch"
            describedBy={`${uid}-rules-note`} />
          <RuleRow id={`${uid}-tired`} on={tiredOn} onToggle={setTiredOn} value={tiredMin} onValue={setTiredMin} stretch={stretch}
            toggleLabel="Break more often once the worker reports feeling tired" fieldLabel="Work between breaks from that time"
            describedBy={`${uid}-rules-note`} />
        </fieldset>

        {errors.length > 0 && (
          <div className="error-box" role="alert"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
        )}
        <div className="form-actions">
          <button type="submit" ref={ctaRef} className="button-cta" onClick={() => setPulse((n) => n + 1)}>
            {plan ? "Generate a new draft" : "Generate draft schedule"}
            {pulse > 0 && <span key={pulse} className="cta-pulse" aria-hidden="true" />}
          </button>
          {plan && edited && <span className="muted">This replaces your edits (you’ll be asked first).</span>}
        </div>
      </form>

      <div className={`sticky-generate ${stickyOn ? "show" : ""}`} aria-hidden={!stickyOn}>
        <button type="submit" form={formId} className="button-cta" tabIndex={stickyOn ? 0 : -1} onClick={() => setPulse((n) => n + 1)}>
          {plan ? "Generate a new draft" : "Generate draft schedule"}
          {pulse > 0 && <span key={pulse} className="cta-pulse" aria-hidden="true" />}
        </button>
      </div>

      <p role="status" className="planner-status">{status}</p>

      {plan && day && (
        <section className="card draft mo-fade-up" aria-labelledby={`${uid}-draft`}>
          <div className="draft-head">
            <div>
              <span className={`basis-badge ${plan.basis.personalized ? "personal" : "general"}`}>
                {plan.basis.personalized ? "Based on shift review" : "General template"}
              </span>
              <span className="eyebrow">Draft{edited ? " · edited" : ""}</span>
              <h3 id={`${uid}-draft`} ref={draftHeading} tabIndex={-1}>
                {plan.days.length > 1 ? "Week draft" : "Day draft"} · {formatTime(plan.settings.startMin)}–{formatTime(plan.settings.endMin)}
              </h3>
            </div>
            <div className="draft-actions">
              <button type="button" onClick={copy}><IconCopy /> Copy as text</button>
              <button type="button" onClick={download}><IconDownload /> Download .txt</button>
              <button type="button" onClick={discard}><IconTrash /> Discard draft</button>
            </div>
          </div>

          <div className={`basis-box with-icon ${plan.basis.personalized ? "personal" : "general"}`}>
            <span className="box-icon" aria-hidden="true">{plan.basis.personalized ? <IconCheckShield size={20} /> : <IconInfo size={20} />}</span>
            <div>
              <p><strong>{plan.basis.title}</strong></p>
              <ul>{plan.basis.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              <p className="muted">
                A draft for the worker and supervisor to review and adjust. It isn’t medical advice, a diagnosis, an injury-risk
                assessment or a safety certification, and a few short clips can’t show everything about a working day.
              </p>
            </div>
          </div>

          {plan.days.length > 1 && (
            <div className="week-result">
              <WeekCalendar plans={draftPlans} startMin={plan.settings.startMin} endMin={plan.settings.endMin}
                current={day.day} onOpen={(d) => { const i = plan.days.findIndex((x) => x.day === d); if (i >= 0) setCurrent(i); }}
                header={(d) => <span className={`wc-day static ${draftPlans[d] ? "on" : ""}`}><span aria-hidden="true">{d}</span><span className="sr-only">{DAY_NAMES[d]}</span></span>} />
              <p className="pp-label wc-hint">Click a day to open its detailed list below.</p>
            </div>
          )}

          {plan.days.length > 1 && (
            <ul className="week-overview" aria-label="Days in this draft">
              {plan.days.map((d, i) => {
                const tot = dayTotals(d.blocks, plan.settings);
                return (
                  <li key={d.day}>
                    <button type="button" className={`week-day ${i === current ? "on" : ""}`} aria-pressed={i === current}
                      onClick={() => setCurrent(i)}>
                      <span className="week-day-name">{DAY_NAMES[d.day]}</span>
                      <DayBar blocks={d.blocks} />
                      <span className="muted week-day-meta">
                        {formatDuration(tot.taskMin)} tasks · {formatDuration(tot.breakMin)} breaks{tot.overrunMin ? ` · ${tot.overrunMin} min over` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <DayEditor key={day.day} day={day} settings={plan.settings} focusAfter={focusAfter}
            onChange={(fn) => editDay(current, fn)} />

          {copyText && (
            <label className="field"><span>Draft as text</span>
              <textarea readOnly rows={Math.min(16, copyText.split("\n").length)} value={copyText} onFocus={(e) => e.target.select()} />
            </label>
          )}
        </section>
      )}

      <aside className="card limits-card mo-fade-up" aria-label="About these suggestions">
        <h3>What the suggestions are, and aren’t</h3>
        <div className="uses-grid">
          <div className="uses-col">
            <p className="uses-title"><IconCheck /> Uses</p>
            <ul>
              <li>The shift, tasks and break rules you enter</li>
              <li>The worker’s own exertion and tiredness ratings, if you use a shift review</li>
              <li>The two rules you set for those ratings</li>
            </ul>
          </div>
          <div className="uses-col not">
            <p className="uses-title"><IconX /> Does not use</p>
            <ul>
              <li>Site rules or legal and contractual break requirements</li>
              <li>Weather and heat, workload, staffing or individual needs</li>
              <li>Movement analysis results</li>
            </ul>
          </div>
        </div>
        <ul>
          <li>They follow only what you entered: the shift, tasks and break rules and, if you use a shift review, the worker’s own exertion and tiredness ratings together with the two rules you set for them. Each task split and break names the rule that caused it.</li>
          <li>The rule values are planning assumptions for you to set. They aren’t validated recovery guidance or legal requirements.</li>
          <li>They don’t know about site rules, legal or contractual break requirements, weather and heat, workload, staffing, or anyone’s individual needs. Check those with your supervisor and the rules that apply to you.</li>
          <li>Movement analysis results aren’t used. A short video can’t determine a working schedule.</li>
          <li>This is a starting point to discuss and adjust, not an approved schedule.</li>
        </ul>
      </aside>
    </div>
  );
}

/** The shift across a 24-hour day (display only). */
function ShiftDayBar({ startMin, endMin }: { startMin: number; endMin: number }) {
  const ok = Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin;
  return (
    <div className="shift-daybar" aria-hidden="true">
      <div className="sd-track">
        {ok && <span className="sd-shift mo-grow-x" style={{ left: `${(startMin / 1440) * 100}%`, width: `${((endMin - startMin) / 1440) * 100}%` }} />}
      </div>
      <div className="sd-hours">{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}</span>)}</div>
    </div>
  );
}

function DayBar({ blocks }: { blocks: Block[] }) {
  const total = blocks.reduce((a, b) => a + b.minutes, 0) || 1;
  return (
    <span className="day-bar" aria-hidden="true">
      {blocks.map((b) => <span key={b.id} className={`seg ${b.kind} ${b.demanding ? "demanding" : ""}`} style={{ flexGrow: b.minutes / total }} />)}
    </span>
  );
}

function DayEditor({ day, settings, focusAfter, onChange }: {
  day: DayPlan; settings: PlannerSettings; focusAfter: { current: string | null };
  onChange: (fn: (b: Block[]) => Block[]) => void;
}) {
  const timed = withTimes(day.blocks, settings.startMin);
  const tot = dayTotals(day.blocks, settings);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const addTaskBtn = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState<string | null>(null);   // display only: links the timeline and the list

  // After a remove or move, keep keyboard focus on a sensible control.
  useEffect(() => {
    const id = focusAfter.current;
    if (id == null) return;
    focusAfter.current = null;
    (id === "add" ? addTaskBtn.current : inputs.current[id])?.focus();
  });

  function remove(i: number) {
    const next = day.blocks[i + 1] ?? day.blocks[i - 1];
    focusAfter.current = next ? next.id : "add";
    onChange((bs) => removeBlock(bs, day.blocks[i].id));
  }

  return (
    <div className="day-editor">
      <div className="day-editor-head">
        <h4>{DAY_NAMES[day.day]}</h4>
        <p className="muted">
          {formatDuration(tot.taskMin)} tasks · {formatDuration(tot.breakMin)} breaks{tot.openMin ? ` · ${formatDuration(tot.openMin)} open` : ""} · ends {formatTime(tot.endMin)}
        </p>
      </div>
      <DaySummary blocks={day.blocks} settings={settings} />
      <DayTimeline blocks={day.blocks} settings={settings} hover={hover} onHover={setHover} />
      {tot.overrunMin > 0 && <p className="note-warn with-icon"><IconAlert size={18} /><span>This day now runs {formatDuration(tot.overrunMin)} past the shift end ({formatTime(settings.endMin)}). Shorten or remove a block if that isn’t intended.</span></p>}
      {tot.earlyMin > 0 && !day.blocks.some((b) => b.kind === "open") && <p className="muted">The blocks end {formatDuration(tot.earlyMin)} before the shift end.</p>}
      {day.unscheduled.length > 0 && (
        <p className="note-warn with-icon">
          <IconAlert size={18} />
          <span>Didn’t fit in the shift: {day.unscheduled.map((u) => `${u.name} (${formatDuration(u.minutes)})`).join(", ")}. Shorten tasks or extend the shift and generate again, or add them by hand.</span>
        </p>
      )}

      <ol className="blocks">
        {timed.map((b, i) => (
          <li key={b.id} className={`block ${b.kind} mo-fade-up ${b.kind === "task" ? "mo-lift" : ""} ${hover === b.id ? "linked" : ""}`}
            style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}
            onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}>
            <span className="block-time">{formatTime(b.start)}–{formatTime(b.end)}</span>
            <div className="block-fields">
              <label className="field grow"><span className="sr-only">Label for {formatTime(b.start)} block</span>
                <input ref={(el) => { inputs.current[b.id] = el; }} type="text" value={b.label}
                  onChange={(e) => onChange((bs) => updateBlock(bs, b.id, { label: e.target.value }))} />
              </label>
              <label className="field kind"><span className="sr-only">Type</span>
                <select value={b.kind} onChange={(e) => onChange((bs) => updateBlock(bs, b.id, { kind: e.target.value as BlockKind }))}>
                  {(Object.keys(KIND_LABEL) as BlockKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="field mins"><span className="sr-only">Minutes</span>
                <input type="number" inputMode="numeric" min={5} max={720} step={5} value={b.minutes}
                  onChange={(e) => onChange((bs) => updateBlock(bs, b.id, { minutes: Math.max(0, Number(e.target.value) || 0) }))} />
                <span aria-hidden="true" className="unit">min</span>
              </label>
              {b.kind === "task" && b.demanding && <span className="tag">demanding</span>}
              {b.reason && <p className="block-why"><span>Why this suggestion:</span> {b.reason}</p>}
            </div>
            <div className="block-actions">
              <button type="button" className="icon-btn" aria-label={`Move ${b.label} earlier`} disabled={i === 0}
                onClick={() => { focusAfter.current = b.id; onChange((bs) => moveBlock(bs, b.id, -1)); }}>↑</button>
              <button type="button" className="icon-btn" aria-label={`Move ${b.label} later`} disabled={i === timed.length - 1}
                onClick={() => { focusAfter.current = b.id; onChange((bs) => moveBlock(bs, b.id, 1)); }}>↓</button>
              <button type="button" className="icon-btn" aria-label={`Remove ${b.label}`} onClick={() => remove(i)}>✕</button>
            </div>
          </li>
        ))}
      </ol>
      <div className="field-row">
        <button type="button" ref={addTaskBtn} onClick={() => onChange((bs) => addBlock(bs, "task", 30))}>+ Add task</button>
        <button type="button" onClick={() => onChange((bs) => addBlock(bs, "break", settings.shortBreakMin || 10))}>+ Add break</button>
      </div>
    </div>
  );
}

/** One optional rule: an on/off switch plus its minutes, with validation and a "no effect" hint. */
function RuleRow({ id, on, onToggle, value, onValue, stretch, toggleLabel, fieldLabel, describedBy }: {
  id: string; on: boolean; onToggle: (v: boolean) => void; value: number | ""; onValue: (v: number | "") => void;
  stretch: number; toggleLabel: string; fieldLabel: string; describedBy: string;
}) {
  const invalid = on && !(typeof value === "number" && Number.isInteger(value) && value >= RULE_MIN && value <= RULE_MAX);
  const noEffect = on && !invalid && typeof value === "number" && value >= stretch;
  return (
    <div className={`rule-row rule-card mo-lift ${on ? "" : "is-off"}`}>
      <label className="check switch-check">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} aria-describedby={describedBy} />
        {toggleLabel}
      </label>
      <label className="field narrow">
        <span>{fieldLabel} (minutes)</span>
        <input id={id} type="number" inputMode="numeric" min={RULE_MIN} max={RULE_MAX} step={5} value={value} disabled={!on}
          aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`}
          onChange={(e) => onValue(e.target.value === "" ? "" : Number(e.target.value))} />
      </label>
      <MinutesSlider value={value} min={RULE_MIN} max={RULE_MAX} step={5} label={`${fieldLabel}, slider (minutes)`} disabled={!on}
        onChange={(v) => onValue(v === "" ? "" : Number(v))} />
      <p id={`${id}-hint`} className={`rule-hint ${invalid ? "error" : "muted"}`}>
        {!on ? "Off: this rule won’t be used."
          : invalid ? `Enter a whole number from ${RULE_MIN} to ${RULE_MAX} minutes.`
          : noEffect ? `Not shorter than your general break interval (${stretch} min), so it won’t change the draft.`
          : `${RULE_MIN}–${RULE_MAX} min.`}
      </p>
    </div>
  );
}
