// EXPERIMENTAL multi-person: a wrong join across a gap shorter than one second must not combine two
// people's results. A brief-gap link is combined automatically only when the association is confident
// (tight fit in position, posture, size and clothing) and no identity-switch warning is near the join.
// Otherwise the link is "uncertain": the label continues, but the stretches are scored and shown apart
// until the user chooses "Confirm same person". Synthetic data only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildTracks, DEFAULT_TRACK_SETTINGS, describeIssues, identityStretches, presentTrack, reviewTracks, segKey, segmentsToScore,
} from "../src/pose/tracks.ts";

const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
/** Upright skeleton, hips at (cx, cy), torso 100·s px. */
function upright(cx, cy, s = 1) {
  const f = empty().map(() => [cx, cy - 50 * s, 0.9]);
  f[5] = [cx - 20 * s, cy - 100 * s, 0.9]; f[6] = [cx + 20 * s, cy - 100 * s, 0.9];
  f[11] = [cx - 15 * s, cy, 0.9]; f[12] = [cx + 15 * s, cy, 0.9];
  return f;
}
/** Bent forward (lifting, laying bricks): shoulders and head forward and low; torso about 92 px. */
function bent(cx, cy) {
  const f = empty().map(() => [cx + 90, cy - 40, 0.9]);
  f[5] = [cx + 55, cy - 70, 0.9]; f[6] = [cx + 75, cy - 60, 0.9];
  f[11] = [cx - 15, cy, 0.9]; f[12] = [cx + 15, cy, 0.9];
  return f;
}
/** people: [{id, from, to, x(t), pose?(x, y), app?(t)}] */
function clip(T, people) {
  return Array.from({ length: T }, (_, t) => people
    .filter((p) => t >= p.from && t < p.to)
    .map((p) => ({ id: p.id, score: 0.8, kp: (p.pose ?? upright)(p.x(t), 500), app: p.app?.(t) ?? null })));
}
const LIGHT = [0.66, 0.63, 0.66, 0.6, 0.59, 0.66];
const PINK = [0.83, 0.69, 0.69, 0.13, 0.13, 0.18];
const BEIGE = [0.75, 0.72, 0.65, 0.3, 0.3, 0.32];
const BEIGE_ISH = [0.62, 0.6, 0.5, 0.42, 0.42, 0.44];   // close to BEIGE, but not the same (distance ~0.22, below the 0.3 veto)

/** A fake API answer for each segment that may be scored: one window per 48 frames, the first above threshold. */
function fakeScores(r) {
  const out = {};
  for (const t of r.tracks) for (const s of segmentsToScore(t)) {
    const n = Math.floor((s.end - s.start) / 48);
    out[segKey(s)] = { kind: "ok", result: {
      model: "fake", threshold: 0.66, interpretation: "", posture_summary: {}, windows_analyzed: n, windows_above_threshold: n ? 1 : 0, percentage_above_threshold: 0,
      windows: Array.from({ length: n }, (_, i) => ({ window: i + 1, start_sample: i * 48, start_seconds: (i * 48) / 25, end_seconds: ((i + 1) * 48) / 25, reconstruction_score: i ? 0.3 : 0.9, above_threshold: i === 0 })),
    } };
  }
  return out;
}
const segs = (r) => r.tracks.flatMap((t) => t.segments.map((s) => `${s.part}:${s.start}-${s.end}:${s.scoreableWindows}`)).sort();
// Turn off the confident-link gates (what linking did before): shows the case would otherwise be combined.
const OLD_GATES = { confidentDist: Infinity, confidentShape: Infinity, confidentSize: Infinity, appearanceCaution: Infinity };

// Worker 1 stands at x=600 (0–4.0 s) and walks out behind a pallet. 0.6 s later the tracker starts a new ID on
// worker 2, who is bent over laying bricks 30 px away. Clothing colour is unknown (small, low-contrast people).
const swap = clip(250, [
  { id: 1, from: 0, to: 100, x: () => 600 },
  { id: 2, from: 115, to: 250, x: () => 630, pose: bent },
]);

describe("one person leaves and another appears within 1 s", () => {
  const r = buildTracks(swap);
  const t = r.tracks[0];

  test("the gap is under one second and, without the new gates, would have been a confident join", () => {
    assert.ok(15 / 25 < 1);
    const old = buildTracks(swap, OLD_GATES);
    assert.deepEqual(old.tracks[0].links.map((l) => [l.key, l.confidence, l.gap]), [["1>2", "confident", 15]]);
    assert.equal(presentTrack(old.tracks[0], fakeScores(old)).kind, "combined", "the risk this guards against");
  });

  test("the link is kept for the label but marked uncertain, with the reason", () => {
    assert.equal(r.tracks.length, 1);
    assert.deepEqual(t.links.map((l) => [l.key, l.confidence, l.gap, l.doubts]), [["1>2", "uncertain", 15, ["posture"]]]);
    assert.equal(t.identity, "uncertain");
    assert.deepEqual(identityStretches(t).map((s) => [s.index, s.parts, s.start, s.end]), [[1, ["1"], 0, 100], [2, ["2"], 115, 250]]);
    const w = describeIssues(t, 250);
    assert.ok(w.some((x) => /Identity unconfirmed at 0:04.6: .*only 0.6 s.*posture.*not combined.*Confirm same person/.test(x)), w.join(" | "));
    assert.ok(!w.some((x) => /joined under one label because they line up/.test(x)));
  });

  test("their scores stay separate: one result per stretch, each from its own frames only", () => {
    const p = presentTrack(t, fakeScores(r));
    assert.equal(p.kind, "per-stretch");
    assert.equal(p.score, undefined, "no combined score");
    const [s1, s2] = p.stretches;
    assert.deepEqual([s1.score.result.windows.length, s2.score.result.windows.length], [2, 2]);
    assert.ok(s1.score.result.windows.every((x) => x.end_seconds <= 100 / 25), "stretch 1 = worker 1 only");
    assert.ok(s2.score.result.windows.every((x) => x.start_seconds >= 115 / 25), "stretch 2 = worker 2 only");
    const entries = reviewTracks(t, p);
    assert.deepEqual(entries.map((e) => [e.key, e.windows, e.aboveTrained]), [["A.1", 2, 1], ["A.2", 2, 1]]);
    assert.ok(entries.every((e) => /identity not confirmed/.test(e.label)));
  });

  test("only “Confirm same person” combines them, and the result is marked as the user’s call", () => {
    const c = buildTracks(swap, {}, { separate: [], merge: [], confirm: ["1>2"] });
    const tc = c.tracks[0];
    assert.deepEqual(tc.links.map((l) => [l.confidence, l.doubts]), [["manual", ["posture"]]]);
    const p = presentTrack(tc, fakeScores(c));
    assert.equal(p.kind, "combined");
    assert.equal(p.confirmedByUser, true);
    assert.equal(p.score.result.windows.length, 4);
    assert.deepEqual(reviewTracks(tc, p).map((e) => e.key), ["A"]);
  });

  test("separating instead gives two people, each with their own result", () => {
    const s = buildTracks(swap, {}, { separate: ["1>2"], merge: [] });
    assert.deepEqual(s.tracks.map((x) => [x.label, x.rawIds, presentTrack(x, fakeScores(s)).kind]), [["A", [1], "combined"], ["B", [2], "combined"]]);
  });

  test("labels and the scored segments are the same however the link is classified or edited", () => {
    assert.deepEqual(r.tracks.map((x) => [x.label, x.rawIds]), buildTracks(swap, OLD_GATES).tracks.map((x) => [x.label, x.rawIds]));
    for (const edits of [{ separate: [], merge: [], confirm: ["1>2"] }, { separate: ["1>2"], merge: [] }]) {
      assert.deepEqual(segs(buildTracks(swap, {}, edits)), segs(r));
    }
    assert.deepEqual(segs(r), segs(buildTracks(swap, { relink: false })));
  });
});

describe("other brief-gap joins that aren't confident", () => {
  const cases = [
    { name: "a bigger (or closer) person appears", doubt: "size", people: [
      { id: 1, from: 0, to: 100, x: () => 600 }, { id: 2, from: 112, to: 250, x: () => 600, pose: (x, y) => upright(x, y, 1.3) }] },
    { name: "they reappear a full torso length away", doubt: "position", people: [
      { id: 1, from: 0, to: 100, x: () => 600 }, { id: 2, from: 112, to: 250, x: () => 700 }] },
    { name: "clothing colours are similar but not the same", doubt: "clothing", people: [
      { id: 1, from: 0, to: 100, x: () => 600, app: () => BEIGE }, { id: 2, from: 112, to: 250, x: () => 600, app: () => BEIGE_ISH }] },
    { name: "someone else walks through the spot during the gap", doubt: "nearby", people: [
      { id: 1, from: 0, to: 100, x: () => 600 }, { id: 2, from: 112, to: 250, x: () => 600 },
      { id: 9, from: 0, to: 250, x: (t) => 200 + 4 * t, pose: (x, y) => upright(x, y - 40) }] },
    { name: "the pose jumps onto a neighbour for 2 frames right before the gap", doubt: "jump", people: [
      { id: 1, from: 0, to: 100, x: (t) => (t === 93 || t === 94 ? 750 : 600) }, { id: 2, from: 112, to: 250, x: () => 600 }] },
    { name: "the clothing colour changes at the end of the earlier fragment (switch warning)", doubt: "switch", people: [
      { id: 1, from: 0, to: 100, x: () => 600, app: (t) => (t < 92 ? LIGHT : PINK) }, { id: 2, from: 112, to: 250, x: () => 600, app: () => PINK }] },
  ];
  for (const c of cases) {
    test(`${c.name}: uncertain (${c.doubt}), scores per stretch until confirmed`, () => {
      const poses = clip(250, c.people);
      const r = buildTracks(poses);
      const t = r.tracks.find((x) => x.rawIds.includes(2));
      // Still linked over a gap under 1 s: before this change every such link was "confident" and its results combined.
      assert.deepEqual(t.rawIds, [1, 2], "still linked for the label");
      const l = t.links[0];
      assert.ok(l.gap < 25, `gap ${l.gap}`);
      assert.equal(l.confidence, "uncertain");
      assert.ok(l.doubts.includes(c.doubt), JSON.stringify(l.doubts));
      assert.equal(presentTrack(t, fakeScores(r)).kind, "per-stretch");
      const confirmed = buildTracks(poses, {}, { separate: [], merge: [], confirm: [l.key] });
      assert.equal(presentTrack(confirmed.tracks.find((x) => x.rawIds.includes(2)), fakeScores(confirmed)).kind, "combined");
    });
  }
});

describe("confident brief-gap links behave as before", () => {
  const cases = {
    "walking on after a 0.4 s loss": [{ id: 1, from: 0, to: 60, x: (t) => 300 + t }, { id: 2, from: 70, to: 140, x: (t) => 300 + t }],
    "standing still, lost for 0.5 s, someone else far away": [
      { id: 1, from: 0, to: 200, x: () => 200 }, { id: 2, from: 0, to: 80, x: () => 600 }, { id: 3, from: 92, to: 200, x: () => 600 }],
    "hand-over (new ID a few frames early)": [{ id: 1, from: 0, to: 80, x: () => 300 }, { id: 2, from: 77, to: 150, x: () => 300 }],
    "same clothes, lost for 0.96 s": [
      { id: 1, from: 0, to: 100, x: () => 600, app: () => BEIGE }, { id: 2, from: 124, to: 250, x: () => 602, app: () => BEIGE }],
    "two walkers both lost while crossing (told apart by direction)": [
      { id: 1, from: 0, to: 35, x: (t) => 300 + 5 * t, app: () => LIGHT }, { id: 2, from: 0, to: 35, x: (t) => 700 - 5 * t, app: () => LIGHT },
      { id: 3, from: 50, to: 100, x: (t) => 300 + 5 * t, app: () => LIGHT }, { id: 4, from: 50, to: 100, x: (t) => 700 - 5 * t, app: () => LIGHT }],
  };
  for (const [name, people] of Object.entries(cases)) {
    test(name, () => {
      const poses = clip(250, people);
      const r = buildTracks(poses);
      const linked = r.tracks.filter((t) => t.links.length);
      assert.ok(linked.length > 0);
      for (const t of linked) {
        assert.ok(t.links.every((l) => l.confidence === "confident" && l.doubts.length === 0), JSON.stringify(t.links.map((l) => [l.key, l.doubts])));
        assert.equal(identityStretches(t).length, 1);
        const p = presentTrack(t, fakeScores(r));
        assert.equal(p.kind, "combined");
        assert.equal(p.confirmedByUser, false);
        assert.deepEqual(reviewTracks(t, p).map((e) => e.key), [t.label]);
      }
      // Same tracks and links as linking without the new gates.
      const old = buildTracks(poses, OLD_GATES);
      assert.deepEqual(r.tracks.map((t) => [t.label, t.rawIds, t.links.map((l) => l.confidence)]), old.tracks.map((t) => [t.label, t.rawIds, t.links.map((l) => l.confidence)]));
    });
  }
});

describe("model scoring and thresholds are unchanged", () => {
  test("window rules and existing tracking settings keep their values", () => {
    const { window, pmin, maxMissing, minLabelFrames, maxDropout, jumpTorsos, relink, relinkMaxGap, relinkMaxDist, duplicateDist,
      uncertainMaxGap, handoverOverlap, ambiguityMargin, suggestDist, duplicateIoU, dedup, appearanceVeto, switchMaxSpan } = DEFAULT_TRACK_SETTINGS;
    assert.deepEqual({ window, pmin, maxMissing, minLabelFrames, maxDropout, jumpTorsos, relink, relinkMaxGap, relinkMaxDist, duplicateDist,
      uncertainMaxGap, handoverOverlap, ambiguityMargin, suggestDist, duplicateIoU, dedup, appearanceVeto, switchMaxSpan }, {
      window: 48, pmin: 0.02, maxMissing: 0.3, minLabelFrames: 12, maxDropout: 5, jumpTorsos: 1.0, relink: true, relinkMaxGap: 25, relinkMaxDist: 1.5,
      duplicateDist: 0.5, uncertainMaxGap: 250, handoverOverlap: 5, ambiguityMargin: 0.5, suggestDist: 3, duplicateIoU: 0.5, dedup: true,
      appearanceVeto: 0.3, switchMaxSpan: 25,
    });
  });

  test("presented results carry the API's scores and trained threshold untouched", () => {
    const r = buildTracks(swap);
    const api = fakeScores(r);
    const p = presentTrack(r.tracks[0], api);
    for (const { stretch, score } of p.stretches) {
      const seg = segmentsToScore(r.tracks[0]).find((s) => stretch.parts.includes(s.part));
      const own = api[segKey(seg)].result;
      assert.equal(score.result.threshold, own.threshold);
      assert.deepEqual(score.result.windows.map((w) => [w.reconstruction_score, w.above_threshold]), own.windows.map((w) => [w.reconstruction_score, w.above_threshold]));
    }
  });
});
