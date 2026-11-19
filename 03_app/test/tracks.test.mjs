// EXPERIMENTAL multi-person track post-processing: labels, segments, rejoin, jumps, duplicates,
// and the guarantee that a scored segment only contains one tracker ID's poses.
// Identity cases (brief occlusion, reappearance, duplicates, crossing, user edits) are further down;
// the recorded two-person regression clip is in tracks.regression.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTracks, describeIssues, segmentFrames, trackLabel, trackSummary, trackTimes } from "../src/pose/tracks.ts";

const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
/** Upright skeleton with hips at (cx, cy) and a 100 px torso; conf p for all points. */
function body(cx, cy, p = 0.9) {
  const f = empty().map(() => [cx, cy - 50, p]);
  f[5] = [cx - 20, cy - 100, p]; f[6] = [cx + 20, cy - 100, p];
  f[11] = [cx - 15, cy, p]; f[12] = [cx + 15, cy, p];
  return f;
}
/** T frames; people: [{id, from, to, x(t), y?(t), missing?, conf?(t), app?}] (app: clothing colour, 6 numbers) */
function clip(T, people) {
  return Array.from({ length: T }, (_, t) => people
    .filter((p) => t >= p.from && t < p.to && !(p.missing ?? []).includes(t))
    .map((p) => ({ id: p.id, score: 0.8, kp: body(p.x(t), p.y?.(t) ?? 500, p.conf?.(t) ?? 0.9), ...(p.app ? { app: p.app } : {}) })));
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const labelOf = (r, rawId) => r.tracks.find((t) => t.rawIds.includes(rawId))?.label;

describe("labels and segments", () => {
  test("labels by first appearance; one segment per continuous track", () => {
    const r = buildTracks(clip(120, [
      { id: 7, from: 10, to: 120, x: (t) => 600 + t },
      { id: 3, from: 0, to: 100, x: (t) => 200 + t },
    ]));
    assert.deepEqual(r.tracks.map((t) => [t.label, t.rawIds[0]]), [["A", 3], ["B", 7]]);
    assert.equal(r.maxPeople, 2);
    const a = r.tracks[0];
    assert.equal(a.segments.length, 1);
    assert.deepEqual([a.segments[0].start, a.segments[0].end, a.segments[0].fullWindows, a.segments[0].scoreableWindows], [0, 100, 2, 2]);
    assert.ok(a.scoreable);
    assert.equal(trackLabel(26), "AA");
  });

  test("short gaps are kept inside a segment; long dropouts split it", () => {
    const r = buildTracks(clip(150, [{ id: 1, from: 0, to: 150, x: () => 300, missing: [40, 41, 42, ...Array.from({ length: 20 }, (_, i) => 90 + i)] }]));
    const t = r.tracks[0];
    assert.deepEqual(t.segments.map((s) => [s.start, s.end]), [[0, 90], [110, 150]]);
    assert.ok(t.issues.some((i) => i.kind === "dropout" && i.start === 90 && i.end === 110));
    assert.deepEqual(trackSummary(t), { windows: 1, scoreable: 1, duplicate: false });
  });

  test("a track never long enough for a full window is not scoreable", () => {
    const r = buildTracks(clip(100, [{ id: 1, from: 0, to: 40, x: () => 300 }]));
    assert.equal(r.tracks[0].scoreable, false);
  });

  test("too few visible points makes a window unscoreable (server's 70% rule)", () => {
    const r = buildTracks(clip(48, [{ id: 1, from: 0, to: 48, x: () => 300, conf: (t) => (t < 20 ? 0.9 : 0.01) }]));
    assert.equal(r.tracks[0].segments[0].scoreableWindows, 0);
    assert.equal(r.tracks[0].scoreable, false);
  });

  test("very brief detections are not labelled", () => {
    const r = buildTracks(clip(60, [{ id: 1, from: 0, to: 60, x: () => 300 }, { id: 2, from: 5, to: 10, x: () => 900 }]));
    assert.equal(r.tracks.length, 1);
    assert.deepEqual(r.brief, [{ rawId: 2, frames: 5 }]);
  });
});

describe("rejoin, jumps, duplicates", () => {
  test("a split track is rejoined for the label, but scored as two segments", () => {
    const poses = clip(140, [{ id: 1, from: 0, to: 60, x: (t) => 300 + t }, { id: 2, from: 70, to: 140, x: (t) => 300 + t }]);
    const on = buildTracks(poses);
    assert.equal(on.tracks.length, 1);
    assert.deepEqual(on.tracks[0].rawIds, [1, 2]);
    assert.ok(on.tracks[0].issues.some((i) => i.kind === "rejoin" && i.frame === 70 && i.gap === 10));
    assert.deepEqual(on.tracks[0].segments.map((s) => s.rawId), [1, 2]);
    assert.equal(buildTracks(poses, { relink: false }).tracks.length, 2);
  });

  test("fragments far apart are not rejoined", () => {
    const r = buildTracks(clip(140, [{ id: 1, from: 0, to: 60, x: () => 100 }, { id: 2, from: 65, to: 140, x: () => 900 }]));
    assert.equal(r.tracks.length, 2);
  });

  test("a sudden jump ends the segment", () => {
    const r = buildTracks(clip(120, [{ id: 1, from: 0, to: 120, x: (t) => (t < 60 ? 200 : 800) }]));
    const t = r.tracks[0];
    assert.ok(t.issues.some((i) => i.kind === "jump" && i.frame === 60));
    assert.deepEqual(t.segments.map((s) => [s.start, s.end]), [[0, 60], [60, 120]]);
  });

  test("a second detection on top of the same person is absorbed before labelling", () => {
    const r = buildTracks(clip(100, [{ id: 1, from: 0, to: 100, x: () => 300 }, { id: 2, from: 20, to: 80, x: () => 305 }]));
    assert.equal(r.tracks.length, 1);
    assert.deepEqual(r.tracks[0].rawIds, [1]);
    assert.deepEqual(r.tracks[0].absorbed, [2]);
    assert.equal(r.maxPeople, 1);
    assert.equal(r.maxDetections, 2);
    assert.ok(r.tracks[0].scoreable);
    // the scored frames still come only from tracker 1
    assert.ok(r.tracks[0].rawIdAt.every((id) => id === 1));
  });
});

describe("separation guarantee", () => {
  test("segment frames only contain that tracker ID's poses", () => {
    const poses = clip(140, [
      { id: 1, from: 0, to: 60, x: () => 300 }, { id: 2, from: 62, to: 140, x: () => 310 },   // rejoined pair
      { id: 9, from: 0, to: 140, x: () => 900 },                                                // someone else
    ]);
    const r = buildTracks(poses);
    for (const t of r.tracks) {
      for (const s of t.segments) {
        const fr = segmentFrames(t, s, empty);
        assert.equal(fr.length, s.end - s.start);
        fr.forEach((f, i) => {
          const at = s.start + i;
          const src = poses[at].find((p) => p.id === s.rawId);
          if (f[11][2] > 0) assert.deepEqual(f, src.kp, `frame ${at} of ${t.label} must come from tracker ${s.rawId}`);
        });
      }
    }
  });
});

describe("warnings", () => {
  test("coverage, dropouts, rejoins and duplicates are described with times", () => {
    const poses = clip(200, [
      { id: 1, from: 0, to: 60, x: (t) => 300 + t }, { id: 2, from: 70, to: 150, x: (t) => 300 + t },
      { id: 5, from: 20, to: 80, x: (t) => 325 + t },   // walks right next to A
    ]);
    const r = buildTracks(poses);
    const a = describeIssues(r.tracks.find((t) => t.label === "A"), 200);
    assert.ok(a.some((w) => /Detected in 70% of the clip \(0:00.0–0:06.0\)/.test(w)), a.join(" | "));
    // The 0.4 s gap is brief, but tracker 5 walks right next to that spot during it (and is flagged as a
    // possible duplicate), so the join isn't confident: identity unconfirmed, results not combined.
    assert.ok(a.some((w) => /Identity unconfirmed at 0:02.8: .*someone else was detected close by during the gap/.test(w)), a.join(" | "));
    // tracker 5 sits next to A (same keypoints, boxes only partly overlapping): flagged, not silently dropped
    const dup = r.tracks.find((t) => t.rawIds.includes(5));
    assert.ok(describeIssues(dup, 200).some((w) => /same person detected twice/.test(w)));
    assert.equal(dup.identity, "uncertain");
  });
});

test("warns when knees and ankles are mostly missing (partly in view)", () => {
  const r = buildTracks(clip(60, [{ id: 1, from: 0, to: 60, x: () => 300 }]).map((ps) => ps.map((p) => {
    p.kp[13] = p.kp[14] = p.kp[15] = p.kp[16] = [0, 0, 0.05];
    return p;
  })));
  assert.ok(describeIssues(r.tracks[0], 60).some((w) => /Knees and ankles weren’t clearly detected in 100%/.test(w)));
  assert.ok(!describeIssues(buildTracks(clip(60, [{ id: 1, from: 0, to: 60, x: () => 300 }])).tracks[0], 60).some((w) => /Knees/.test(w)));
});
