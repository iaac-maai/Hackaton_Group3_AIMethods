import type { KeypointResult, ScoredWindow } from "../api";
import type { ReviewTrack } from "../review";
import type { Frame } from "./coco";

// EXPERIMENTAL multi-person post-processing (pure; no DOM). Turns MoveNet MultiPose output with
// tracker IDs into per-person tracks labelled A, B, C … in order of first appearance.
//
// Pipeline
//  1. Fragments: every tracker ID is a fragment. The library's tracker starts a new ID whenever a
//     person is undetected for a while (common for small or low-contrast workers, whose detection
//     scores sit near MoveNet's 0.25 cut-off), so one person often arrives as several fragments.
//  2. Duplicates: two fragments that sit on top of each other (same keypoints, overlapping boxes)
//     for most of the time they co-exist are the same person detected twice; the smaller one is
//     absorbed before any label is given. Weaker overlap is only flagged ("possible duplicate").
//  3. Association: fragments that don't overlap in time are linked when the later one starts where
//     the earlier one's motion says the person should be (hip centre, constant-velocity prediction),
//     at a similar size (torso length) and posture. A link is
//       - confident only when the gap is brief (<= relinkMaxGap), no other fragment fits about as
//         well, the fit is tight (position, posture, size, clothing: confident* settings) and nothing
//         near the join warns of an identity switch (a clothing-colour change on either part, a
//         sudden jump next to the gap, a possible duplicate, someone else close by during the gap);
//       - uncertain otherwise (a longer gap up to uncertainMaxGap, or a brief gap with any of those
//         doubts, listed in TrackLink.doubts): the label continues, the gap is shown as an uncertain
//         section, scores are kept per stretch, and the user can confirm or separate it;
//       - not made when two candidates fit about equally well or the fit is only loose; the track is
//         then flagged "may be the same person as Track X" so the user can merge it.
//  3b. Identity switches inside one tracker ID: when the clothing colour clearly changes part-way
//     through a tracker ID (src/pose/appearance.ts), the tracker probably jumped to another person.
//       - Located (the change starts and ends inside the fragment, within switchMaxSpan): the ID is
//         split into parts before linking, and the short band around the change is never scored.
//       - Not located (it runs into the start/end of the fragment, or is spread out): every segment
//         overlapping it is withheld from scoring. A score that might mix two people is never shown.
//     Switch warnings stay on the track whatever the user merges or separates.
//  4. Labels are given after 1–3, so a brief detection loss never changes them. User edits
//     (merge/separate) keep every label that still exists; a split-off part gets a new letter.
//
// Guarantees (unchanged):
//  - A track's frames only ever come from poses the tracker gave one of that track's fragments.
//    Frames from two people are never mixed into one frame.
//  - Scoring happens per *segment*: a run of one tracker ID with no long dropout and no sudden
//    jump. A scored window therefore never spans a tracker ID change, a link or a jump, and each
//    segment is sent to the API on its own so the server's clip-wide normalisation only sees that
//    segment's frames. Linking, deduplication and user edits change labels, never what one
//    segment contains. Only segmentsToScore() may be sent; segmentFrames() refuses a withheld one.
//
// Labels are temporary and only mean something within one clip; they do not identify a worker.
// Window rules mirror 02_model_server/keypoint_utils.py (WINDOW 48, PMIN 0.02, MAX_MISSING 0.30).

/** `app`: optional clothing colour (src/pose/appearance.ts: torso RGB, thigh RGB, 0..1; NaN/null = unknown). */
export interface RawPose { id: number; score: number; kp: Frame; app?: readonly (number | null)[] | null }

export interface TrackSettings {
  window: number;          // frames per scored window (keypoint_utils.WINDOW)
  pmin: number;            // point counts as visible at this confidence (PMIN)
  maxMissing: number;      // window skipped when more than this share of points is missing (MAX_MISSING)
  minLabelFrames: number;  // shorter tracks are treated as brief detections, not labelled
  maxDropout: number;      // a gap of more than this many frames ends a segment
  jumpTorsos: number;      // hip-centre move per frame (in torso lengths) treated as a jump
  relink: boolean;         // link fragments of one person under one label
  relinkMaxGap: number;    // frames; links over gaps up to this are confident
  relinkMaxDist: number;   // hip-centre distance from the predicted position, in torso lengths
  duplicateDist: number;   // median keypoint distance (torso lengths) for "the same person twice"
  uncertainMaxGap: number; // frames; links over longer gaps (up to this) are kept but marked uncertain
  handoverOverlap: number; // frames two fragments of one person may overlap when the tracker hands over
  ambiguityMargin: number; // a link is only made when the runner-up fits worse by at least this (torso lengths)
  suggestDist: number;     // looser fit (torso lengths) that only produces a "may be the same person" hint
  duplicateIoU: number;    // median box overlap (IoU) also required to absorb a duplicate
  dedup: boolean;          // absorb duplicate detections before labelling
  appearanceVeto: number;  // clothing-colour distance (0..1.7) above which two ends are treated as different people
  switchMaxSpan: number;   // frames; a colour change spread wider than this can't be located, so its segment is withheld
  // A brief-gap link is only confident (results combined automatically) within all of these:
  confidentDist: number;   // fit: distance from the predicted position, torso lengths
  confidentShape: number;  // posture difference at the two ends (hip-centred, torso-scaled)
  confidentSize: number;   // |log| of the torso-length ratio at the two ends
  appearanceCaution: number; // clothing-colour distance above which a link isn't confident (below appearanceVeto, which blocks it)
}

export const DEFAULT_TRACK_SETTINGS: TrackSettings = {
  window: 48, pmin: 0.02, maxMissing: 0.3,
  minLabelFrames: 12, maxDropout: 5, jumpTorsos: 1.0,
  relink: true, relinkMaxGap: 25, relinkMaxDist: 1.5, duplicateDist: 0.5,
  uncertainMaxGap: 250, handoverOverlap: 5, ambiguityMargin: 0.5, suggestDist: 3, duplicateIoU: 0.5, dedup: true,
  appearanceVeto: 0.3, switchMaxSpan: 25,
  confidentDist: 0.75, confidentShape: 0.5, confidentSize: 0.2, appearanceCaution: 0.15,
};

/**
 * User corrections. `separate`: link keys (TrackLink.key) to undo. `merge`: pairs of fragments whose
 * tracks are one person, each a tracker ID or a part key (Track.parts, e.g. "2#2" after a split).
 */
export interface TrackEdits {
  separate: string[];
  merge: [number | string, number | string][];
  confirm?: string[];   // uncertain link keys the user confirmed as one person (become "manual" links)
}
export const NO_EDITS: TrackEdits = { separate: [], merge: [], confirm: [] };

export interface Segment {
  start: number;            // first frame (inclusive)
  end: number;              // last frame + 1
  rawId: number;
  fullWindows: number;      // floor(length / window)
  scoreableWindows: number; // full windows with enough visible points (the server's rule)
  part: string;             // fragment part the frames come from (tracker ID, or "id#n" after a switch split)
  withheld?: string;        // why this segment must not be scored (it may contain two people)
}

export type LinkConfidence = "confident" | "uncertain" | "manual";

/** Why a link isn't confident. Any doubt makes it "uncertain": its stretches are scored and shown apart until the user confirms. */
export type LinkDoubt =
  | "long-gap"   // gap longer than relinkMaxGap
  | "position"   // reappears further from the predicted position than confidentDist
  | "posture"    // posture before and after differs (confidentShape)
  | "size"       // body size before and after differs (confidentSize)
  | "clothing"   // clothing colours differ somewhat (appearanceCaution; above appearanceVeto there is no link at all)
  | "switch"     // a clothing-colour change (identity switch) is flagged on one of the two parts
  | "jump"       // a sudden jump right before or after the gap
  | "duplicate"  // one of the two parts is flagged as a possible duplicate detection
  | "nearby";    // someone else was detected close to the spot during the gap

export interface TrackLink {
  key: string;              // `${from}>${to}`; pass in TrackEdits.separate to undo
  from: number;             // tracker ID before the gap
  to: number;               // tracker ID after the gap
  fromPart: string;         // fragment parts (see Segment.part)
  toPart: string;
  frame: number;            // first frame of the later fragment
  gapStart: number;         // first frame without either fragment
  gap: number;              // frames between the fragments (0 for a hand-over)
  confidence: LinkConfidence;
  fit: number;              // distance from the predicted position, torso lengths (NaN for manual)
  doubts: LinkDoubt[];      // why the automatic link isn't confident (kept after the user confirms; empty for a manual merge)
}

export type TrackIssue =
  | { kind: "dropout"; start: number; end: number }   // frames [start, end) without this track
  | { kind: "rejoin"; frame: number; gap: number; confidence: LinkConfidence; key: string }
  | { kind: "jump"; frame: number }
  | { kind: "duplicate"; of: string }                 // overlaps another track for a while (same person twice?)
  | { kind: "possible-same"; of: string; frame: number; why: "ambiguous" | "loose" | "looks-different" }
  // Clothing colour changes inside one tracker ID: the tracker probably switched people. Frames [start, end)
  // are where the switch may be. located: the ID was split there; otherwise overlapping segments are withheld.
  | { kind: "appearance-change"; frame: number; rawId: number; start: number; end: number; located: boolean }
  | { kind: "merged-duplicate"; rawId: number; frames: number };

export interface UncertainSection { start: number; end: number; reason: string }

export interface Track {
  label: string;
  rawIds: number[];           // tracker IDs joined into this track, in time order
  parts: string[];            // fragment parts (a tracker ID split at an identity switch has several)
  partAt: (string | null)[];  // which fragment part supplied each frame
  absorbed: number[];         // duplicate tracker IDs absorbed into this track
  frames: (Frame | null)[];   // per clip frame; null where this track wasn't detected
  rawIdAt: (number | null)[]; // which tracker ID supplied each frame
  present: number;            // frames with a pose
  first: number;
  last: number;
  segments: Segment[];
  links: TrackLink[];
  issues: TrackIssue[];
  uncertain: UncertainSection[];  // stretches where this track's identity isn't certain
  identity: "confident" | "uncertain";
  scoreable: boolean;         // at least one segment that isn't withheld has a scoreable window
}

export interface TrackResult {
  frameCount: number;
  tracks: Track[];
  brief: { rawId: number; frames: number }[];   // too short to label
  maxPeople: number;          // most distinct people in one frame, after removing duplicate detections
  maxDetections: number;      // most raw detections in one frame
}

const hip = (f: Frame) => [(f[11][0] + f[12][0]) / 2, (f[11][1] + f[12][1]) / 2] as const;
const torsoLen = (f: Frame) => Math.hypot((f[5][0] + f[6][0]) / 2 - (f[11][0] + f[12][0]) / 2, (f[5][1] + f[6][1]) / 2 - (f[11][1] + f[12][1]) / 2);
const coreVisible = (f: Frame) => [5, 6, 11, 12].every((k) => f[k][2] >= 0.3);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const KP_MIN = 0.2;

export function trackLabel(i: number): string {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function box(f: Frame): [number, number, number, number] | null {
  const v = f.filter((p) => p[2] >= KP_MIN);
  if (v.length < 3) return null;
  return [Math.min(...v.map((p) => p[0])), Math.min(...v.map((p) => p[1])), Math.max(...v.map((p) => p[0])), Math.max(...v.map((p) => p[1]))];
}
function iou(a: Frame, b: Frame): number {
  const p = box(a), q = box(b);
  if (!p || !q) return NaN;
  const w = Math.max(0, Math.min(p[2], q[2]) - Math.max(p[0], q[0])), h = Math.max(0, Math.min(p[3], q[3]) - Math.max(p[1], q[1]));
  const inter = w * h, union = (p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - inter;
  return union > 0 ? inter / union : NaN;
}
/** Mean distance between keypoints visible in both poses, in units of `scale`. */
function poseDist(a: Frame, b: Frame, scale: number): number {
  let s = 0, n = 0;
  for (let k = 0; k < a.length; k++) if (a[k][2] >= KP_MIN && b[k][2] >= KP_MIN) { s += Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]); n++; }
  if (n < 4) { const [ax, ay] = hip(a), [bx, by] = hip(b); return Math.hypot(ax - bx, ay - by) / scale; }
  return s / n / scale;
}
/** Posture difference after removing position and size (hip-centred, torso-scaled). */
function shapeDist(a: Frame, b: Frame, sa: number, sb: number): number {
  const [ax, ay] = hip(a), [bx, by] = hip(b);
  let s = 0, n = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k][2] < KP_MIN || b[k][2] < KP_MIN) continue;
    s += Math.hypot((a[k][0] - ax) / sa - (b[k][0] - bx) / sb, (a[k][1] - ay) / sa - (b[k][1] - by) / sb); n++;
  }
  return n >= 4 ? s / n : NaN;
}

/** A fragment: one tracker ID, plus any duplicate tracker IDs absorbed into it. */
interface Unit {
  id: number;                  // tracker ID (the main one)
  key: string;                 // part key: "<id>", or "<id>#<n>" for later parts after a switch split
  at: Map<number, Frame>;
  src: Map<number, number>;    // frame -> tracker ID that supplied it
  app: Map<number, number[]>;  // frame -> clothing colour (6 numbers, NaN = unknown)
  times: number[];             // sorted frames
  first: number;
  last: number;
  scale: number;               // typical torso length (px)
  absorbed: { rawId: number; frames: number }[];
  withheld: { start: number; end: number }[];   // possible switch that couldn't be located: don't score here
}

function unitScale(frames: Frame[]): number {
  const t = median(frames.filter(coreVisible).map(torsoLen).filter((x) => x > 1));
  if (t > 1) return t;
  // No clear torso: about a third of the visible body height.
  const h = median(frames.map(box).filter((b): b is NonNullable<ReturnType<typeof box>> => b != null).map((b) => (b[3] - b[1]) / 3).filter((x) => x > 1));
  return h > 1 ? h : NaN;
}

interface EndState { t: number; x: number; y: number; vx: number; vy: number; pose: Frame }

/** Position (mean of the 3 frames nearest the end) and velocity (least squares over up to 10 frames, kept only when clearly non-zero). */
function endState(u: Unit, side: "head" | "tail"): EndState {
  const ts = side === "tail" ? u.times.slice(-10) : u.times.slice(0, 10);
  const near = side === "tail" ? ts.slice(-3) : ts.slice(0, 3);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const pts = ts.map((t) => hip(u.at.get(t)!));
  const nearPts = near.map((t) => hip(u.at.get(t)!));
  const st: EndState = { t: mean(near), x: mean(nearPts.map((p) => p[0])), y: mean(nearPts.map((p) => p[1])), vx: 0, vy: 0, pose: u.at.get(side === "tail" ? u.last : u.first)! };
  if (ts.length >= 4) {
    const tm = mean(ts), sxx = ts.reduce((s, t) => s + (t - tm) ** 2, 0);
    if (sxx > 0) {
      for (const axis of [0, 1] as const) {
        const vals = pts.map((p) => p[axis]), m = mean(vals);
        const slope = ts.reduce((s, t, i) => s + (t - tm) * (vals[i] - m), 0) / sxx;
        const res = ts.reduce((s, t, i) => s + (vals[i] - m - slope * (t - tm)) ** 2, 0);
        const se = Math.sqrt(res / Math.max(1, ts.length - 2) / sxx);
        if (Math.abs(slope) > 3 * se) { if (axis === 0) st.vx = slope; else st.vy = slope; }
      }
    }
  }
  return st;
}

/** Median clothing colour over the given frames (NaN parts when unknown). */
function appOf(u: Unit, ts: number[]): number[] {
  const rows = ts.map((t) => u.app.get(t)).filter((a): a is number[] => a != null);
  return [0, 1, 2, 3, 4, 5].map((i) => median(rows.map((r) => r[i]).filter(Number.isFinite)));
}
/** Mean over the parts known on both sides (torso, thighs) of the RGB distance; NaN if none. */
function appDist(a: number[], b: number[]): number {
  const parts: number[] = [];
  for (const o of [0, 3]) {
    const d = Math.hypot(a[o] - b[o], a[o + 1] - b[o + 1], a[o + 2] - b[o + 2]);
    if (Number.isFinite(d)) parts.push(d);
  }
  return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : NaN;
}
const END_FRAMES = 10;

export interface SwitchFinding { rawId: number; frame: number; start: number; end: number; located: boolean; parts: string[] }

/**
 * Where a tracker ID's clothing colour clearly changes (it probably switched people). For each split
 * point i the medians of the 10 colour frames before and after are compared; a run of split points
 * above appearanceVeto is one change. A clean switch at frame k gives a run of about k-4 .. k+5, so
 * the switch lies inside the run. The run is "located" only if low distances bound it on both sides
 * (it doesn't run into the start or end of the colour data) and it spans at most switchMaxSpan frames.
 */
function findSwitches(u: Unit, S: TrackSettings): Omit<SwitchFinding, "parts">[] {
  const ts = u.times.filter((t) => u.app.has(t));
  if (ts.length < 2 * END_FRAMES) return [];
  const lo = END_FRAMES, hi = ts.length - END_FRAMES;
  const out: Omit<SwitchFinding, "parts">[] = [];
  let runStart = -1;
  const flush = (a: number, b: number) => {
    const truncated = a === lo || b === hi;
    const located = !truncated && ts[b] - ts[a] <= S.switchMaxSpan;
    out.push({
      rawId: u.id, frame: ts[Math.floor((a + b) / 2)], located,
      start: a === lo ? u.first : ts[a], end: b === hi ? u.last + 1 : ts[b] + 1,
    });
  };
  for (let i = lo; i <= hi; i++) {
    const d = appDist(appOf(u, ts.slice(i - END_FRAMES, i)), appOf(u, ts.slice(i, i + END_FRAMES)));
    const high = Number.isFinite(d) && d > S.appearanceVeto;
    if (high && runStart < 0) runStart = i;
    if (!high && runStart >= 0) { flush(runStart, i - 1); runStart = -1; }
  }
  if (runStart >= 0) flush(runStart, hi);
  return out;
}

/** Cut a unit at located switches (dropping the band where the switch may be); note the rest as withheld. */
function splitAtSwitches(u: Unit, S: TrackSettings, findings: SwitchFinding[]): Unit[] {
  const found = findSwitches(u, S);
  if (!found.length) return [u];
  const bands = found.filter((f) => f.located);
  const parts: Unit[] = [];
  let n = 0;
  const make = (from: number, to: number): Unit | null => {   // frames in [from, to)
    const times = u.times.filter((t) => t >= from && t < to);
    if (!times.length) return null;
    const pick = <V>(m: Map<number, V>) => new Map(times.filter((t) => m.has(t)).map((t) => [t, m.get(t)!] as [number, V]));
    const p: Unit = {
      id: u.id, key: n++ === 0 ? u.key : `${u.key}#${n}`, at: pick(u.at), src: pick(u.src), app: pick(u.app), times,
      first: times[0], last: times[times.length - 1], scale: NaN, absorbed: n === 1 ? u.absorbed : [], withheld: [],
    };
    p.scale = unitScale([...p.at.values()]);
    return p;
  };
  let from = -Infinity;
  for (const b of bands) { const p = make(from, b.start); if (p) parts.push(p); from = b.end; }
  const tail = make(from, Infinity); if (tail) parts.push(tail);
  if (!parts.length) return [];
  for (const f of found) {
    // Located: the parts on either side of the cut. Not located: every part overlapping the uncertain stretch.
    const near = f.located
      ? [parts.filter((p) => p.last < f.start).pop(), parts.find((p) => p.first >= f.end)].filter((p): p is Unit => p != null)
      : parts.filter((p) => p.first < f.end && p.last >= f.start);
    if (!f.located) for (const p of near) p.withheld.push({ start: f.start, end: f.end });
    findings.push({ ...f, parts: near.map((p) => p.key) });
  }
  return parts;
}

interface Candidate { from: Unit; to: Unit; gap: number; fit: number; cost: number; looksDifferent: boolean; shape: number; size: number; look: number }

/** How well `b` continues `a` (null if it can't: overlaps, too far in time, or a different size). */
function candidate(a: Unit, b: Unit, S: TrackSettings): Candidate | null {
  if (b.first <= a.first || b.last <= a.last) return null;
  const gap = b.first - a.last - 1;
  if (gap > S.uncertainMaxGap) return null;
  const scale = a.scale > 1 ? a.scale : b.scale;
  if (!(scale > 1)) return null;
  if (a.scale > 1 && b.scale > 1 && (b.scale / a.scale < 0.67 || b.scale / a.scale > 1.5)) return null;
  if (gap < 0) {
    // Hand-over: the tracker started a new ID before dropping the old one. Allowed only for a few
    // frames, and only if both IDs are on the same person throughout.
    const both = a.times.filter((t) => t >= b.first && b.at.has(t));
    if (both.length > S.handoverOverlap) return null;
    if (both.some((t) => poseDist(a.at.get(t)!, b.at.get(t)!, scale) >= S.duplicateDist)) return null;
  }
  const ta = endState(a, "tail"), hb = endState(b, "head");
  const dt = Math.min(Math.max(0, hb.t - ta.t), 2 * S.relinkMaxGap);  // don't extrapolate motion far
  const fwd = Math.hypot(hb.x - (ta.x + ta.vx * dt), hb.y - (ta.y + ta.vy * dt));
  const back = Math.hypot(ta.x - (hb.x - hb.vx * dt), ta.y - (hb.y - hb.vy * dt));
  const fit = (fwd + back) / 2 / scale;
  const shape = shapeDist(ta.pose, hb.pose, a.scale > 1 ? a.scale : scale, b.scale > 1 ? b.scale : scale);
  const size = a.scale > 1 && b.scale > 1 ? Math.abs(Math.log(b.scale / a.scale)) : 0;
  // Clothing colour at the two ends (when known). Clearly different colours veto the link.
  const look = appDist(appOf(a, a.times.slice(-END_FRAMES)), appOf(b, b.times.slice(0, END_FRAMES)));
  const looksDifferent = Number.isFinite(look) && look > S.appearanceVeto;
  const cost = fit + 0.5 * (Number.isFinite(shape) ? shape : 0) + 0.5 * size + (Number.isFinite(look) ? look : 0) + 0.002 * Math.max(0, gap);
  return { from: a, to: b, gap: Math.max(0, gap), fit, cost, looksDifferent, shape, size, look };
}

/** Step 1: tracker IDs -> fragments. Step 2: absorb duplicate detections. */
function buildUnits(poses: RawPose[][], S: TrackSettings) {
  const raw = new Map<number, Unit>();
  poses.forEach((ps, t) => {
    for (const p of ps) {
      let u = raw.get(p.id);
      if (!u) raw.set(p.id, (u = { id: p.id, key: String(p.id), at: new Map(), src: new Map(), app: new Map(), times: [], first: t, last: t, scale: NaN, absorbed: [], withheld: [] }));
      if (u.at.has(t)) continue;   // the same ID twice in one frame: keep the first
      u.at.set(t, p.kp); u.src.set(t, p.id); u.times.push(t); u.last = t;
      if (p.app && p.app.length === 6) u.app.set(t, p.app.map((v) => (typeof v === "number" ? v : NaN)));
    }
  });
  for (const u of raw.values()) u.scale = unitScale([...u.at.values()]);

  const possibleDup: [number, number][] = [];   // [smaller, larger] tracker IDs
  const into = new Map<number, number>();
  if (S.dedup) {
    const list = [...raw.values()].sort((a, b) => b.times.length - a.times.length || a.id - b.id);   // larger first
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const big = list[i], small = list[j];
        if (small.last < big.first || small.first > big.last) continue;
        // The same person detected twice has the same size; measure in the smaller person's torso lengths.
        if (big.scale > 1 && small.scale > 1 && (small.scale / big.scale < 0.67 || small.scale / big.scale > 1.5)) continue;
        const scale = Math.min(...[big.scale, small.scale].filter((v) => v > 1));
        if (!(scale > 1)) continue;
        const d: number[] = [], o: number[] = [];
        for (const t of small.times) {
          const fb = big.at.get(t);
          if (!fb) continue;
          const fs = small.at.get(t)!;
          d.push(poseDist(fs, fb, scale));
          const v = iou(fs, fb); if (Number.isFinite(v)) o.push(v);
        }
        if (d.length < Math.min(10, small.times.length) || d.length < 0.5 * small.times.length) continue;
        if (median(d) >= S.duplicateDist) continue;
        // Two people close together (one in front of the other) can share keypoints; different clothing rules that out.
        const co = small.times.filter((t) => big.at.has(t));
        const look = appDist(appOf(small, co), appOf(big, co));
        if (Number.isFinite(look) && look > S.appearanceVeto) continue;
        if (o.length && median(o) >= S.duplicateIoU) { if (!into.has(small.id)) into.set(small.id, big.id); }
        else possibleDup.push([small.id, big.id]);
      }
    }
  }
  const root = (id: number): number => { let r = id; while (into.has(r)) r = into.get(r)!; return r; };
  for (const [s] of into) {
    const big = raw.get(root(s))!, small = raw.get(s)!;
    for (const t of small.times) {
      if (big.at.has(t)) continue;
      big.at.set(t, small.at.get(t)!); big.src.set(t, small.src.get(t)!);
      const a = small.app.get(t); if (a) big.app.set(t, a);
    }
    big.absorbed.push({ rawId: s, frames: small.times.length }, ...small.absorbed);
  }
  const whole = [...raw.values()].filter((u) => !into.has(u.id));
  for (const u of whole) {
    u.times = [...u.at.keys()].sort((a, b) => a - b);
    u.first = u.times[0]; u.last = u.times[u.times.length - 1];
  }
  // Step 2b: identity switches inside one tracker ID.
  const switches: SwitchFinding[] = [];
  const units = whole.flatMap((u) => splitAtSwitches(u, S, switches));
  units.sort((a, b) => a.first - b.first || a.id - b.id || a.key.localeCompare(b.key));
  return { units, switches, possibleDup: possibleDup.map(([s, b]) => [root(s), root(b)] as [number, number]).filter(([s, b]) => s !== b) };
}

/** A sudden hip move (more than jumpTorsos torso lengths per frame) among the END_FRAMES frames at one end of a fragment. */
function jumpAtEnd(u: Unit, side: "head" | "tail", S: TrackSettings): boolean {
  if (!(u.scale > 1)) return false;
  const ts = side === "tail" ? u.times.slice(-END_FRAMES) : u.times.slice(0, END_FRAMES);
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > 2) continue;
    const [ax, ay] = hip(u.at.get(ts[i - 1])!), [bx, by] = hip(u.at.get(ts[i])!);
    if (Math.hypot(ax - bx, ay - by) > S.jumpTorsos * u.scale * dt) return true;
  }
  return false;
}

interface Warnings { switchParts: Set<string>; dupIds: Set<number> }

/** Everything that keeps a link from being confident (see LinkDoubt). It never changes whether the link is made. */
function linkDoubts(c: Candidate, units: Unit[], S: TrackSettings, warn: Warnings): LinkDoubt[] {
  const d: LinkDoubt[] = [];
  const { from: a, to: b } = c;
  if (c.gap > S.relinkMaxGap) d.push("long-gap");
  if (!(c.fit <= S.confidentDist)) d.push("position");
  if (Number.isFinite(c.shape) && c.shape > S.confidentShape) d.push("posture");
  if (c.size > S.confidentSize) d.push("size");
  if (Number.isFinite(c.look) && c.look > S.appearanceCaution) d.push("clothing");
  if (warn.switchParts.has(a.key) || warn.switchParts.has(b.key)) d.push("switch");
  if (jumpAtEnd(a, "tail", S) || jumpAtEnd(b, "head", S)) d.push("jump");
  if (warn.dupIds.has(a.id) || warn.dupIds.has(b.id)) d.push("duplicate");
  // Someone else detected near the spot while neither fragment was: the tracker may have picked them up.
  const scale = a.scale > 1 ? a.scale : b.scale;
  const ends = [hip(a.at.get(a.last)!), hip(b.at.get(b.first)!)];
  const near = units.some((o) => o !== a && o !== b && o.id !== a.id && o.id !== b.id && o.times.some((t) => {
    if (t <= a.last || t >= b.first) return false;
    const [x, y] = hip(o.at.get(t)!);
    return ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= S.relinkMaxDist * scale);
  }));
  if (near) d.push("nearby");
  return d;
}

type Hint = "ambiguous" | "loose" | "looks-different";
interface Chain { units: Unit[]; links: TrackLink[]; hints: { other: Unit; at: Unit; why: Hint }[] }

/** Step 3: link fragments into chains (one per person). */
function associate(units: Unit[], S: TrackSettings, edits: TrackEdits, warn: Warnings): Chain[] {
  const separate = new Set(edits.separate);
  const confirmed = new Set(edits.confirm ?? []);
  const next = new Map<Unit, Candidate>(), prev = new Map<Unit, Candidate>();
  const hints: { a: Unit; b: Unit; why: Hint }[] = [];
  if (S.relink) {
    const all: Candidate[] = [];
    for (const a of units) for (const b of units) {
      if (a === b || separate.has(`${a.key}>${b.key}`)) continue;
      const c = candidate(a, b, S);
      if (c) all.push(c);
    }
    const gated = all.filter((c) => c.fit <= S.relinkMaxDist && !c.looksDifferent).sort((x, y) => x.cost - y.cost);
    const blocked = new Set<Candidate>();
    const unsureFrom = new Set<Unit>(), unsureTo = new Set<Unit>();   // ends with a tie: never linked automatically
    for (const c of gated) {
      if (blocked.has(c) || next.has(c.from) || prev.has(c.to) || unsureFrom.has(c.from) || unsureTo.has(c.to)) continue;
      // Another free fragment fits almost as well on either side: don't guess.
      const rivals = gated.filter((r) => r !== c && !blocked.has(r) && r.cost - c.cost < S.ambiguityMargin &&
        ((r.from === c.from && !prev.has(r.to)) || (r.to === c.to && !next.has(r.from))));
      if (rivals.length) {
        for (const r of [c, ...rivals]) {
          blocked.add(r); unsureFrom.add(r.from); unsureTo.add(r.to);
          hints.push({ a: r.from, b: r.to, why: "ambiguous" });
        }
        continue;
      }
      next.set(c.from, c); prev.set(c.to, c);
    }
    // A loose fit between a track that ends and one that starts, neither of them linked: a hint only.
    for (const c of all) {
      if (c.fit <= S.suggestDist && !blocked.has(c) && !next.has(c.from) && !prev.has(c.to)) {
        hints.push({ a: c.from, b: c.to, why: c.fit <= S.relinkMaxDist && c.looksDifferent ? "looks-different" : "loose" });
      }
    }
  }
  const chains: Chain[] = [];
  const chainOf = new Map<Unit, Chain>();
  for (const u of units) {
    if (prev.has(u)) continue;
    const ch: Chain = { units: [], links: [], hints: [] };
    for (let cur: Unit | undefined = u; cur; ) {
      ch.units.push(cur); chainOf.set(cur, ch);
      const c = next.get(cur);
      if (!c) break;
      const doubts = linkDoubts(c, units, S, warn);
      ch.links.push({
        key: `${c.from.key}>${c.to.key}`, from: c.from.id, to: c.to.id, fromPart: c.from.key, toPart: c.to.key,
        frame: c.to.first, gapStart: c.from.last + 1, gap: c.gap,
        confidence: confirmed.has(`${c.from.key}>${c.to.key}`) ? "manual" : doubts.length ? "uncertain" : "confident", fit: c.fit, doubts,
      });
      cur = c.to;
    }
    chains.push(ch);
  }
  for (const h of hints) {
    const ca = chainOf.get(h.a)!, cb = chainOf.get(h.b)!;
    if (ca === cb) continue;
    cb.hints.push({ other: h.a, at: h.b, why: h.why });
  }

  // Manual merges (pairs of fragments: a part key, or a tracker ID meaning its first part).
  const byRaw = (x: number | string) => chains.find((c) => c.units.some((u) => u.key === String(x)))
    ?? chains.find((c) => c.units.some((u) => u.id === x || u.absorbed.some((a) => a.rawId === x)));
  for (const [x, y] of edits.merge) {
    const cx = byRaw(x), cy = byRaw(y);
    if (!cx || !cy || cx === cy) continue;
    const [early, late] = cx.units[0].first <= cy.units[0].first ? [cx, cy] : [cy, cx];
    const units2 = [...early.units, ...late.units].sort((a, b) => a.first - b.first || a.id - b.id || a.key.localeCompare(b.key));
    const links = [...early.links, ...late.links];
    // A manual link at every place where the two tracks hand over to each other.
    for (let i = 1; i < units2.length; i++) {
      const a = units2[i - 1], b = units2[i];
      if (links.some((l) => l.toPart === b.key)) continue;
      links.push({ key: `${a.key}>${b.key}`, from: a.id, to: b.id, fromPart: a.key, toPart: b.key, frame: b.first, gapStart: Math.min(a.last + 1, b.first), gap: Math.max(0, b.first - a.last - 1), confidence: "manual", fit: NaN, doubts: [] });
    }
    early.units = units2; early.links = links.sort((p, q) => p.frame - q.frame);
    early.hints = [...early.hints, ...late.hints];
    chains.splice(chains.indexOf(late), 1);
  }
  return chains;
}

/** Shared detection of segments, jumps and dropouts for one track's frames (unchanged rules). */
function segmentsOf(frames: (Frame | null)[], rawIdAt: (number | null)[], partAt: (string | null)[], first: number, last: number, S: TrackSettings) {
  const issues: TrackIssue[] = [];
  const torso = median(frames.filter((f): f is Frame => f != null && coreVisible(f)).map(torsoLen).filter((t) => t > 1));
  const jumpAt = new Set<number>();
  let prev = -1;
  for (let t = first; t <= last; t++) {
    const f = frames[t];
    if (!f) continue;
    if (prev >= 0 && t - prev <= 2 && rawIdAt[prev] === rawIdAt[t] && torso > 1) {
      const [ax, ay] = hip(frames[prev]!), [bx, by] = hip(f);
      if (Math.hypot(ax - bx, ay - by) > S.jumpTorsos * torso * (t - prev)) { jumpAt.add(t); issues.push({ kind: "jump", frame: t }); }
    }
    prev = t;
  }
  const segments: Segment[] = [];
  let segStart = -1, segId: number | null = null, segPart: string | null = null, lastSeen = -1;
  const close = (end: number) => {
    if (segStart < 0) return;
    const len = end - segStart, full = Math.floor(len / S.window);
    let ok = 0;
    for (let w = 0; w < full; w++) {
      const s = segStart + w * S.window;
      if (visibleShare(frames, s, s + S.window, S.pmin) >= 1 - S.maxMissing) ok++;
    }
    segments.push({ start: segStart, end, rawId: segId!, part: segPart!, fullWindows: full, scoreableWindows: ok });
    segStart = -1;
  };
  for (let t = first; t <= last; t++) {
    const f = frames[t];
    if (!f) continue;
    const gap = lastSeen >= 0 ? t - lastSeen - 1 : 0;
    if (gap > 0 && gap > S.maxDropout) issues.push({ kind: "dropout", start: lastSeen + 1, end: t });
    if (segStart >= 0 && (rawIdAt[t] !== segId || partAt[t] !== segPart || gap > S.maxDropout || jumpAt.has(t))) close(lastSeen + 1);
    if (segStart < 0) { segStart = t; segId = rawIdAt[t]; segPart = partAt[t]; }
    lastSeen = t;
  }
  close(lastSeen + 1);
  return { segments, issues };
}

/** Share of points visible (p >= pmin) over frames [s, e), missing frames counting as invisible. */
function visibleShare(frames: (Frame | null)[], s: number, e: number, pmin: number): number {
  let ok = 0;
  for (let t = s; t < e; t++) { const f = frames[t]; if (f) for (const p of f) if (p[2] >= pmin) ok++; }
  return ok / ((e - s) * 17);
}

const chainFrames = (c: Chain) => c.units.reduce((a, u) => a + u.times.length, 0);

export function buildTracks(poses: RawPose[][], settings: Partial<TrackSettings> = {}, edits: TrackEdits = NO_EDITS): TrackResult {
  const S = { ...DEFAULT_TRACK_SETTINGS, ...settings };
  const T = poses.length;
  const { units, switches, possibleDup } = buildUnits(poses, S);
  const chains = associate(units, S, edits, {
    switchParts: new Set(switches.flatMap((f) => f.parts)),
    dupIds: new Set(possibleDup.flat()),
  });

  const brief: TrackResult["brief"] = [];
  const kept = chains.filter((c) => {
    if (chainFrames(c) >= S.minLabelFrames) return true;
    c.units.forEach((u) => brief.push({ rawId: u.id, frames: u.times.length }));
    return false;
  }).sort((a, b) => a.units[0].first - b.units[0].first || a.units[0].id - b.units[0].id || a.units[0].key.localeCompare(b.units[0].key));

  // Labels by first appearance. With edits, every track keeps the label its first fragment had
  // without edits, so merging or separating never renames the other tracks.
  const labels = new Map<Chain, string>();
  if (edits.separate.length || edits.merge.length || edits.confirm?.length) {
    const auto = buildTracks(poses, settings);
    const autoLabel = new Map<string, string>();
    for (const t of auto.tracks) autoLabel.set(t.parts[0], t.label);
    const used = new Set<string>();
    let nextIdx = auto.tracks.length;
    for (const c of kept) {
      const l = autoLabel.get(c.units[0].key);
      if (l && !used.has(l)) { labels.set(c, l); used.add(l); }
    }
    for (const c of kept) {
      if (labels.has(c)) continue;
      let l: string;
      do { l = trackLabel(nextIdx++); } while (used.has(l));
      labels.set(c, l); used.add(l);
    }
  } else kept.forEach((c, i) => labels.set(c, trackLabel(i)));
  const labelOfUnit = new Map<string, string>();
  for (const c of kept) for (const u of c.units) labelOfUnit.set(u.key, labels.get(c)!);

  const tracks: Track[] = kept.map((c) => {
    const frames: (Frame | null)[] = Array(T).fill(null);
    const rawIdAt: (number | null)[] = Array(T).fill(null);
    const partAt: (string | null)[] = Array(T).fill(null);
    for (const u of c.units) for (const t of u.times) if (!frames[t]) { frames[t] = u.at.get(t)!; rawIdAt[t] = u.src.get(t)!; partAt[t] = u.key; }
    const first = Math.min(...c.units.map((u) => u.first)), last = Math.max(...c.units.map((u) => u.last));
    const { segments, issues: segIssues } = segmentsOf(frames, rawIdAt, partAt, first, last, S);
    // A segment overlapping a switch that couldn't be located may hold two people: never score it.
    for (const seg of segments) {
      const u = c.units.find((x) => x.key === seg.part);
      const w = u?.withheld.find((x) => x.start < seg.end && x.end > seg.start);
      if (w) seg.withheld = `the tracker may have switched to another person between ${clockAt(w.start)} and ${clockAt(w.end)}, and where exactly can’t be pinned down`;
    }
    const issues: TrackIssue[] = [
      ...c.links.map((l) => ({ kind: "rejoin" as const, frame: l.frame, gap: l.gap, confidence: l.confidence, key: l.key })),
      ...segIssues,
      ...c.units.flatMap((u) => u.absorbed.map((a) => ({ kind: "merged-duplicate" as const, rawId: a.rawId, frames: a.frames }))),
    ];
    const uncertain: UncertainSection[] = [];
    for (const l of c.links) {
      if (l.confidence === "confident") continue;
      uncertain.push({ start: l.gapStart, end: l.frame, reason: l.confidence === "manual" ? "joined by you"
        : l.doubts.includes("long-gap") && l.doubts.length === 1 ? "not detected; joined because the person reappears at the same place and size"
        : `${l.doubts.includes("long-gap") ? "not detected" : "brief gap"}, but ${doubtText(l.doubts)}; identity unconfirmed, so results aren’t combined until you confirm` });
    }
    for (const h of c.hints) {
      const of = labelOfUnit.get(h.other.key);
      if (!of || of === labels.get(c) || issues.some((i) => i.kind === "possible-same" && i.of === of)) continue;
      issues.push({ kind: "possible-same", of, frame: h.at.first, why: h.why });
      uncertain.push({ start: h.at.first, end: Math.min(h.at.last + 1, h.at.first + 1), reason: `may be the same person as Track ${of}` });
    }
    for (const i of segIssues) if (i.kind === "jump") uncertain.push({ start: i.frame, end: i.frame + 1, reason: "sudden jump; the tracker may have switched people" });
    // Switch warnings follow the fragment parts, so no merge or separation can remove them.
    const keys = new Set(c.units.map((u) => u.key));
    for (const f of switches) {
      if (!f.parts.some((k) => keys.has(k))) continue;
      issues.push({ kind: "appearance-change", frame: f.frame, rawId: f.rawId, start: f.start, end: f.end, located: f.located });
      uncertain.push({ start: f.start, end: f.end, reason: f.located
        ? "clothing colour changes: the tracker probably switched to another person; split here, and this stretch isn’t scored"
        : "clothing colour changes: the tracker may have switched to another person somewhere here; overlapping stretches aren’t scored" });
    }
    uncertain.sort((a, b) => a.start - b.start);
    return {
      label: labels.get(c)!, rawIds: [...new Set(c.units.map((u) => u.id))], parts: c.units.map((u) => u.key),
      absorbed: c.units.flatMap((u) => u.absorbed.map((a) => a.rawId)),
      partAt, frames, rawIdAt, present: frames.filter(Boolean).length, first, last, segments, links: c.links, issues, uncertain,
      identity: uncertain.length ? "uncertain" : "confident", scoreable: segments.some((s) => s.scoreableWindows > 0 && !s.withheld),
    };
  });

  // Weaker overlap (same keypoints but boxes don't agree): flagged, left for the user to merge.
  for (const [s, b] of possibleDup) {
    const ts = tracks.find((t) => t.rawIds.includes(s)), tb = tracks.find((t) => t.rawIds.includes(b));
    if (!ts || !tb || ts === tb || ts.issues.some((i) => i.kind === "duplicate")) continue;
    const [small, big] = ts.present <= tb.present ? [ts, tb] : [tb, ts];
    small.issues.push({ kind: "duplicate", of: big.label });
    small.uncertain.push({ start: small.first, end: small.last + 1, reason: `overlaps Track ${big.label}; may be the same person detected twice` });
    small.identity = "uncertain";
  }

  tracks.sort((a, b) => a.first - b.first || a.label.localeCompare(b.label));
  let maxDetections = 0;
  for (const ps of poses) maxDetections = Math.max(maxDetections, ps.length);
  let maxPeople = 0;
  for (let t = 0; t < T; t++) {
    let n = 0;
    for (const u of units) if (u.at.has(t)) n++;
    maxPeople = Math.max(maxPeople, n);
  }
  return { frameCount: T, tracks, brief, maxPeople, maxDetections };
}

/** The only segments that may be sent for scoring: a full scoreable window, and not withheld. */
export function segmentsToScore(track: Track): Segment[] {
  return track.segments.filter((s) => s.scoreableWindows > 0 && !s.withheld);
}

/** Segments that would have been scored but are withheld because they may contain two people. */
export function withheldSegments(track: Track): Segment[] {
  return track.segments.filter((s) => s.scoreableWindows > 0 && s.withheld);
}

/** The frames sent to the API for one segment: only this tracker ID's poses; gaps are empty frames. */
export function segmentFrames(track: Track, seg: Segment, empty: () => Frame): Frame[] {
  if (seg.withheld) throw new Error(`Segment ${clockAt(seg.start)}–${clockAt(seg.end)} of Track ${track.label} is withheld from scoring: ${seg.withheld}.`);
  const out: Frame[] = [];
  for (let t = seg.start; t < seg.end; t++) out.push(track.rawIdAt[t] === seg.rawId && track.frames[t] ? track.frames[t]! : empty());
  return out;
}

export function trackSummary(t: Track) {
  const windows = t.segments.reduce((a, s) => a + s.fullWindows, 0);
  const scoreable = t.segments.reduce((a, s) => a + s.scoreableWindows, 0);
  return { windows, scoreable, duplicate: t.issues.some((i) => i.kind === "duplicate") };
}

export const clockAt = (frame: number, fps = 25) => { const s = frame / fps; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

/** First/last visible time, coverage and uncertain stretches, for display. */
export function trackTimes(t: Track, frameCount: number, fps = 25) {
  return {
    firstSeen: clockAt(t.first, fps), lastSeen: clockAt(t.last + 1, fps),
    coverage: frameCount ? t.present / frameCount : 0,
    uncertain: t.uncertain.map((u) => ({ from: clockAt(u.start, fps), to: clockAt(u.end, fps), reason: u.reason })),
  };
}

/** Plain-language continuity warnings for one track, with times to check on the overlay. */
export function describeIssues(t: Track, frameCount: number, fps = 25): string[] {
  const out: string[] = [];
  const cover = t.present / frameCount;
  if (cover < 0.9) out.push(`Detected in ${Math.round(cover * 100)}% of the clip (${clockAt(t.first, fps)}–${clockAt(t.last + 1, fps)}).`);
  const drops = t.issues.filter((i): i is Extract<TrackIssue, { kind: "dropout" }> => i.kind === "dropout");
  if (drops.length) {
    const longest = drops.reduce((a, d) => (d.end - d.start > a.end - a.start ? d : a));
    out.push(`Lost ${drops.length} time${drops.length > 1 ? "s" : ""} for more than ${((DEFAULT_TRACK_SETTINGS.maxDropout + 1) / fps).toFixed(2)} s; ` +
      `longest gap ${((longest.end - longest.start) / fps).toFixed(1)} s at ${clockAt(longest.start, fps)}.`);
  }
  for (const l of t.links) {
    if (l.confidence === "confident") {
      out.push(`The tracker split this person at ${clockAt(l.frame, fps)}; the pieces were joined under one label because they line up. Check the overlay there — it may be a different person.`);
    } else if (l.confidence === "uncertain" && l.doubts.includes("long-gap")) {
      out.push(`Identity uncertain ${clockAt(l.gapStart, fps)}–${clockAt(l.frame, fps)}: nobody was detected here for ${(l.gap / fps).toFixed(1)} s. ` +
        `The detections before and after are at the same place and size, so they're shown as one person. If it's someone else, separate them.` +
        (l.doubts.length > 1 ? ` Also: ${doubtText(l.doubts)}.` : ""));
    } else if (l.confidence === "uncertain") {
      out.push(`Identity unconfirmed at ${clockAt(l.frame, fps)}: the tracker lost this person for only ${(l.gap / fps).toFixed(1)} s, but ${doubtText(l.doubts)}, ` +
        `so it may be someone else. The stretches before and after are scored separately and not combined. Use “Confirm same person” if it’s one person, or separate them.`);
    } else {
      out.push(`You joined two tracks here at ${clockAt(l.frame, fps)}.`);
    }
  }
  const jumps = t.issues.filter((i) => i.kind === "jump");
  if (jumps.length) out.push(`The pose jumped suddenly ${jumps.length} time${jumps.length > 1 ? "s" : ""} (first at ${clockAt((jumps[0] as { frame: number }).frame, fps)}); it may have switched to someone else.`);
  // Same rule as the single-person quality check (src/pose/quality.ts): knees and ankles at >= 0.2.
  const posed = t.frames.filter((f): f is Frame => f != null);
  const legsMissing = posed.length ? posed.filter((f) => ![13, 14, 15, 16].every((k) => f[k][2] >= 0.2)).length / posed.length : 0;
  if (legsMissing > 0.2) {
    out.push(`Knees and ankles weren’t clearly detected in ${Math.round(legsMissing * 100)}% of this track’s frames. ` +
      "If the person is only partly in view, the skeleton and its scores are less reliable.");
  }
  for (const i of t.issues) {
    if (i.kind === "possible-same") {
      out.push(i.why === "ambiguous"
        ? `From ${clockAt(i.frame, fps)} this could be Track ${i.of} or someone else: more than one person fits, so the tracks were kept apart. Merge them if it’s the same person.`
        : i.why === "looks-different"
        ? `Starts where Track ${i.of} was last seen (${clockAt(i.frame, fps)}), but the clothing colours differ, so the tracks were kept apart. Merge them if it’s the same person.`
        : `May be the same person as Track ${i.of} (starts near where Track ${i.of} was last seen, at ${clockAt(i.frame, fps)}), but the match is too loose to join automatically. Merge them if it is.`);
    }
  }
  for (const i of t.issues) {
    if (i.kind !== "appearance-change") continue;
    out.push(i.located
      ? `The clothing colour changes at about ${clockAt(i.frame, fps)}: the tracker probably switched to another person. The tracking was split there, ` +
        `and ${clockAt(i.start, fps)}–${clockAt(i.end, fps)} isn’t scored. Check the overlay.`
      : `The clothing colour changes between ${clockAt(i.start, fps)} and ${clockAt(i.end, fps)}: the tracker may have switched to another person, ` +
        `but where exactly can’t be pinned down. Stretches that overlap it aren’t scored, because a score could mix two people. Check the overlay.`);
  }
  const held = withheldSegments(t);
  if (held.length) {
    out.push(`Not scored (may contain two people): ${held.map((x) => `${clockAt(x.start, fps)}–${clockAt(x.end, fps)}`).join(", ")}.`);
  }
  const dup = t.issues.find((i): i is Extract<TrackIssue, { kind: "duplicate" }> => i.kind === "duplicate");
  if (dup) out.push(`Mostly overlaps Track ${dup.of}; it may be the same person detected twice. Merge them if so.`);
  const absorbed = t.issues.filter((i): i is Extract<TrackIssue, { kind: "merged-duplicate" }> => i.kind === "merged-duplicate");
  if (absorbed.length) out.push(`${absorbed.length} overlapping second detection${absorbed.length > 1 ? "s" : ""} of this person ${absorbed.length > 1 ? "were" : "was"} merged into this track.`);
  return out;
}

const DOUBT_TEXT: Record<LinkDoubt, string> = {
  "long-gap": "nobody was detected for a long time",
  position: "the person reappears further from where they were heading than usual",
  posture: "the posture before and after the gap differs",
  size: "the body size before and after the gap differs",
  clothing: "the clothing colours before and after the gap differ somewhat",
  switch: "a clothing-colour change (possible identity switch) is flagged on one side",
  jump: "the pose jumps suddenly right next to the gap",
  duplicate: "an overlapping second detection is flagged on one side",
  nearby: "someone else was detected close by during the gap",
};
/** A link's doubts in plain language (the long gap is left out: callers describe it themselves). */
export function doubtText(doubts: LinkDoubt[]): string {
  const t = doubts.filter((d) => d !== "long-gap").map((d) => DOUBT_TEXT[d]);
  return t.length <= 1 ? (t[0] ?? DOUBT_TEXT["long-gap"]) : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// Presenting scores. Fragments joined by an automatic *uncertain* link (a long gap, or a brief gap
// with a doubt or identity-switch warning) may be two people, so their scores are never combined
// into one result: such a track is shown per identity stretch. Confident links and links the user
// joined or confirmed form one stretch.

export interface IdentityStretch {
  index: number;            // 1-based, in time order
  parts: string[];
  start: number;            // first frame
  end: number;              // last frame + 1
  confirmedByUser: boolean; // contains a link the user joined or confirmed
}

/** A track's identity stretches: its parts, cut at every automatic uncertain link. */
export function identityStretches(t: Track): IdentityStretch[] {
  const cutBefore = new Set(t.links.filter((l) => l.confidence === "uncertain").map((l) => l.toPart));
  const groups: string[][] = [];
  for (const p of t.parts) {
    if (!groups.length || cutBefore.has(p)) groups.push([p]);
    else groups[groups.length - 1].push(p);
  }
  return groups.map((parts, i) => {
    const set = new Set(parts);
    let start = Infinity, end = -Infinity;
    t.partAt.forEach((p, f) => { if (p != null && set.has(p)) { start = Math.min(start, f); end = Math.max(end, f + 1); } });
    const confirmedByUser = t.links.some((l) => l.confidence === "manual" && set.has(l.fromPart) && set.has(l.toPart));
    return { index: i + 1, parts, start, end, confirmedByUser };
  }).filter((g) => Number.isFinite(g.start));
}

export type SegScore = { kind: "ok"; result: KeypointResult } | { kind: "skipped" } | { kind: "error"; message: string };
export const segKey = (s: Segment) => `${s.part}:${s.start}:${s.end}`;

export type TrackScore =
  | { kind: "pending" }
  | { kind: "not-scoreable"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "scored"; result: KeypointResult; skippedSegments: number };

export type TrackPresentation =
  | { kind: "combined"; score: TrackScore; confirmedByUser: boolean }
  // Identity not confirmed between stretches: one score per stretch, never a combined one.
  | { kind: "per-stretch"; stretches: { stretch: IdentityStretch; score: TrackScore }[] };

/** Merge per-segment API results onto the clip timeline (times offset by each segment's start). */
export function mergeScoredSegments(parts: { start: number; result: KeypointResult }[], fps = 25, windowS = DEFAULT_TRACK_SETTINGS.window / 25): KeypointResult {
  const windows: ScoredWindow[] = parts
    .flatMap(({ start, result }) => result.windows.map((w) => ({
      ...w,
      start_sample: w.start_sample + start,
      start_seconds: Math.round((w.start_seconds + start / fps) * 1000) / 1000,
      end_seconds: Math.round(((w.end_seconds ?? w.start_seconds + windowS) + start / fps) * 1000) / 1000,
    })))
    .sort((a, b) => a.start_seconds - b.start_seconds)
    .map((w, i) => ({ ...w, window: i + 1 }));
  const above = windows.filter((w) => w.above_threshold).length;
  const first = parts[0].result;
  return {
    model: first.model, threshold: first.threshold, interpretation: first.interpretation, posture_summary: {},
    windows, windows_analyzed: windows.length, windows_above_threshold: above,
    percentage_above_threshold: windows.length ? (above / windows.length) * 100 : 0,
  };
}

function scoreOf(t: Track, parts: Set<string>, segScores: Record<string, SegScore>): TrackScore {
  const segs = segmentsToScore(t).filter((s) => parts.has(s.part)).map((s) => [s, segScores[segKey(s)]] as const);
  if (!segs.length) {
    const held = withheldSegments(t).filter((s) => parts.has(s.part));
    return { kind: "not-scoreable", reason: held.length
      ? `Not scored: the tracker may have switched to another person during ${held.map((x) => `${clockAt(x.start)}–${clockAt(x.end)}`).join(", ")}, `
        + "and where exactly can’t be pinned down. A single score could mix two people, so this stretch isn’t sent for scoring."
      : "Not enough continuous tracking to score: no stretch of at least "
        + `${(DEFAULT_TRACK_SETTINGS.window / 25).toFixed(2)} s where this person was tracked without interruption and enough body points were visible.` };
  }
  const failed = segs.find(([, r]) => r?.kind === "error")?.[1];
  if (failed?.kind === "error") return { kind: "error", message: failed.message };
  if (segs.some(([, r]) => !r)) return { kind: "pending" };
  const ok = segs.flatMap(([s, r]) => (r?.kind === "ok" ? [{ start: s.start, result: r.result }] : []));
  const skipped = segs.filter(([, r]) => r?.kind === "skipped").length;
  return ok.length ? { kind: "scored", result: mergeScoredSegments(ok), skippedSegments: skipped }
    : { kind: "not-scoreable", reason: "Not enough continuous tracking to score: the server found no window with enough visible body points." };
}

/** How a track's scores may be shown: combined only when its identity holds across all its parts. */
export function presentTrack(t: Track, segScores: Record<string, SegScore>): TrackPresentation {
  const stretches = identityStretches(t);
  if (stretches.length <= 1) {
    return { kind: "combined", score: scoreOf(t, new Set(t.parts), segScores), confirmedByUser: stretches[0]?.confirmedByUser ?? false };
  }
  return { kind: "per-stretch", stretches: stretches.map((st) => ({ stretch: st, score: scoreOf(t, new Set(st.parts), segScores) })) };
}

/** Shift-review summary: one entry per track, or one per stretch when the track's identity isn't confirmed. */
export function reviewTracks(t: Track, pres: TrackPresentation): ReviewTrack[] {
  const entry = (key: string, label: string, sc: TrackScore): ReviewTrack => sc.kind === "scored"
    ? { key, label, scored: true, windows: sc.result.windows.length, aboveTrained: sc.result.windows_above_threshold }
    : { key, label, scored: false, windows: 0, aboveTrained: 0 };
  if (pres.kind === "combined") return [entry(t.label, `Track ${t.label}`, pres.score)];
  return pres.stretches.map(({ stretch: st, score }) => entry(`${t.label}.${st.index}`,
    `Track ${t.label}, stretch ${st.index} (${clockAt(st.start)}–${clockAt(st.end)}; identity not confirmed)`, score));
}
