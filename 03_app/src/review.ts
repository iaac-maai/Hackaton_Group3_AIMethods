import type { Exertion, TaskInput } from "./schedule";

// Shift review: analysed clips the user adds from the Analysis tab, plus what the user tells us
// about each one (which person/track, which worker, the task, roughly when and how long, and the
// worker's own exertion/tiredness ratings). It lives in page memory only: never saved to History,
// never stored in the browser, and it holds no video or keypoints.
//
// Planning uses the user-provided task demands, times and self-reports. Movement-deviation results
// are carried only as optional context and are never turned into a fatigue or workload rating.

export type Fatigue = "not" | "little" | "quite" | "very";
export const FATIGUE_LABEL: Record<Fatigue, string> = { not: "Not tired", little: "A little tired", quite: "Quite tired", very: "Very tired" };
const EXERTION_TEXT: Record<Exertion, string> = { "very-light": "Very light", light: "Light", moderate: "Moderate", hard: "Hard", "very-hard": "Very hard" };
const EXERTION_ORDER: Exertion[] = ["very-light", "light", "moderate", "hard", "very-hard"];

/** One analysed person in a clip, as a movement summary only. */
export interface ReviewTrack {
  key: string;            // "single" for a single-person analysis, else the track label
  label: string;          // "Person (single-person analysis)" or "Track B"
  scored: boolean;
  windows: number;        // scored windows
  aboveTrained: number;   // windows above the trained threshold (not the exploratory slider value)
}

export interface ReviewClip {
  id: string;
  name: string;
  durationS: number | null;
  source: "single" | "multi" | "saved";
  tracks: ReviewTrack[];
}

export interface ReviewEntry {
  id: string;
  clipId: string;
  trackKey: string;
  worker: string;
  task: string;
  timeInShift: string;    // "HH:MM" or ""
  minutes: number | null; // approximate time on this task in the shift
  exertion: Exertion | "";
  fatigue: Fatigue | "";
}

export const workerKey = (w: string) => w.trim().replace(/\s+/g, " ").toLowerCase();

export interface WorkerGroup { key: string; name: string; entries: ReviewEntry[]; signature: string; needsConfirmation: boolean }

/** Entries grouped by worker name. Combining more than one clip/track for a worker needs the user's confirmation. */
export function groupWorkers(entries: ReviewEntry[]): WorkerGroup[] {
  const groups = new Map<string, WorkerGroup>();
  for (const e of entries) {
    const key = workerKey(e.worker);
    if (!key) continue;
    const g = groups.get(key) ?? { key, name: e.worker.trim().replace(/\s+/g, " "), entries: [], signature: "", needsConfirmation: false };
    g.entries.push(e);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const pairs = [...new Set(g.entries.map((e) => `${e.clipId}:${e.trackKey}`))].sort();
    g.signature = `${g.key}|${pairs.join(",")}`;
    g.needsConfirmation = pairs.length > 1;
  }
  return [...groups.values()];
}

const parseHHMM = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export interface ReviewPlan {
  personalized: boolean;
  missing: string[];   // what blocks a personalised draft (shown, and a general template is offered instead)
  gaps: string[];      // inputs that were entered but couldn't be used
  basis: string[];     // what the personalised draft is based on
  context: string[];   // optional movement-deviation context (never used for planning)
  tasks: TaskInput[];
  hasHardTask: boolean;
  tiredFromMin: number | null;
}

/** Turn one worker's review entries into planner inputs, or explain what is missing. */
export function planFromReview(group: WorkerGroup | null, clips: ReviewClip[], confirmed: ReadonlySet<string>, newId: () => string): ReviewPlan {
  const out: ReviewPlan = { personalized: false, missing: [], gaps: [], basis: [], context: [], tasks: [], hasHardTask: false, tiredFromMin: null };
  if (!group || !group.entries.length) {
    out.missing.push("Add at least one analysed clip to the shift review and enter the worker it shows.");
    return out;
  }
  const clipOf = (id: string) => clips.find((c) => c.id === id);
  for (const e of group.entries) {
    const c = clipOf(e.clipId), t = c?.tracks.find((x) => x.key === e.trackKey);
    if (c && t) {
      out.context.push(t.scored
        ? `${c.name} · ${t.label}: ${t.aboveTrained} of ${t.windows} scored windows above the trained threshold.`
        : `${c.name} · ${t.label}: not scored (not enough continuous tracking).`);
    }
  }
  if (group.needsConfirmation && !confirmed.has(group.signature)) {
    out.missing.push(`Confirm that the ${new Set(group.entries.map((e) => `${e.clipId}:${e.trackKey}`)).size} clips or tracks entered for ${group.name} all show the same person. Track labels only apply within one video.`);
  }

  // Tasks: one per task name; duration = the longest reported (clips of the same task aren't added up).
  const byTask = new Map<string, { name: string; minutes: number; exertion: Exertion | null }>();
  for (const e of group.entries) {
    const name = e.task.trim();
    if (!name) continue;
    const k = name.toLowerCase();
    const cur = byTask.get(k) ?? { name, minutes: 0, exertion: null };
    if (e.minutes && e.minutes > 0) cur.minutes = Math.max(cur.minutes, e.minutes);
    if (e.exertion && (!cur.exertion || EXERTION_ORDER.indexOf(e.exertion) > EXERTION_ORDER.indexOf(cur.exertion))) cur.exertion = e.exertion;
    byTask.set(k, cur);
  }
  for (const t of byTask.values()) {
    if (t.minutes > 0) {
      const hard = t.exertion === "hard" || t.exertion === "very-hard";
      out.tasks.push({ id: newId(), name: t.name, minutes: t.minutes, demanding: hard, ...(t.exertion ? { exertion: t.exertion } : {}) });
      out.hasHardTask ||= hard;
    } else out.gaps.push(`“${t.name}” has no approximate duration, so it isn’t included.`);
  }
  if (!out.tasks.length) out.missing.push("Enter a task and its approximate duration for at least one clip.");

  // Self-reports: the main personal inputs. Tiredness needs a time in the shift to be used.
  const exertions = group.entries.filter((e) => e.exertion && e.task.trim());
  const tired = group.entries.filter((e) => e.fatigue === "quite" || e.fatigue === "very");
  for (const e of tired) {
    const at = parseHHMM(e.timeInShift);
    if (at == null) out.gaps.push(`A tiredness report${e.task.trim() ? ` for “${e.task.trim()}”` : ""} has no time in the shift, so it isn’t used.`);
    else if (out.tiredFromMin == null || at < out.tiredFromMin) out.tiredFromMin = at;
  }
  if (!exertions.length && out.tiredFromMin == null) {
    out.missing.push("Add the worker’s own exertion or tiredness rating for at least one task. The planner doesn’t infer these from video.");
  }

  out.personalized = out.missing.length === 0;
  if (out.personalized) {
    const nClips = new Set(group.entries.map((e) => e.clipId)).size;
    out.basis.push(`Tasks and durations entered for ${group.name} from ${nClips} reviewed clip${nClips > 1 ? "s" : ""}.`);
    for (const t of out.tasks) if (t.exertion) out.basis.push(`Self-reported exertion: ${t.name}: ${EXERTION_TEXT[t.exertion]}.`);
    for (const e of tired) {
      const at = parseHHMM(e.timeInShift);
      if (at != null) out.basis.push(`Self-reported: ${FATIGUE_LABEL[e.fatigue as Fatigue]} around ${e.timeInShift}${e.task.trim() ? ` (${e.task.trim()})` : ""}.`);
    }
    out.basis.push("Movement-deviation results were not used to set tasks or breaks.");
  }
  return out;
}
