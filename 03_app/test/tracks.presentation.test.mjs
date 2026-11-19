// EXPERIMENTAL multi-person: how scores may be presented. Pieces joined only by an automatic
// *uncertain* link (a long gap) may be different people, so their scores are never combined into one
// person's result: the track is shown per identity stretch, also in the shift-review summary.
// Confident links (brief gaps) and links the user confirmed or merged are combined. Synthetic data only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTracks, identityStretches, presentTrack, reviewTracks, segKey, segmentsToScore } from "../src/pose/tracks.ts";

const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
function body(cx, cy, p = 0.9) {
  const f = empty().map(() => [cx, cy - 50, p]);
  f[5] = [cx - 20, cy - 100, p]; f[6] = [cx + 20, cy - 100, p];
  f[11] = [cx - 15, cy, p]; f[12] = [cx + 15, cy, p];
  return f;
}
function clip(T, people) {
  return Array.from({ length: T }, (_, t) => people
    .filter((p) => t >= p.from && t < p.to)
    .map((p) => ({ id: p.id, score: 0.8, kp: body(p.x(t), 500), app: p.app ?? null })));
}
const BEIGE = [0.75, 0.72, 0.65, 0.3, 0.3, 0.32];

/** A fake API answer for every segment that may be scored: one window per 48 frames, the first above threshold. */
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

// One person at the mixer: tracked 0–100, lost for 4 s, re-found as a new tracker ID 200–350 at the same spot.
const longGap = clip(400, [{ id: 2, from: 0, to: 100, x: () => 600, app: BEIGE }, { id: 4, from: 200, to: 350, x: () => 605, app: BEIGE }]);

describe("identity-uncertain links are never combined into one result", () => {
  const r = buildTracks(longGap);
  const t = r.tracks[0];

  test("the track has two identity stretches, cut at the uncertain link", () => {
    assert.deepEqual(t.links.map((l) => l.confidence), ["uncertain"]);
    assert.deepEqual(identityStretches(t).map((s) => [s.index, s.parts, s.start, s.end]), [[1, ["2"], 0, 100], [2, ["4"], 200, 350]]);
  });

  test("scores are presented per stretch, with no combined result", () => {
    const p = presentTrack(t, fakeScores(r));
    assert.equal(p.kind, "per-stretch");
    assert.equal(p.score, undefined, "no combined score");
    assert.deepEqual(p.stretches.map((x) => [x.stretch.index, x.score.kind, x.score.result.windows.length, x.score.result.windows_above_threshold]),
      [[1, "scored", 2, 1], [2, "scored", 3, 1]]);
  });

  test("the shift review gets one entry per stretch, labelled as not confirmed, never a combined Track A entry", () => {
    const entries = reviewTracks(t, presentTrack(t, fakeScores(r)));
    assert.deepEqual(entries.map((e) => [e.key, e.windows, e.aboveTrained]), [["A.1", 2, 1], ["A.2", 3, 1]]);
    assert.ok(entries.every((e) => /identity not confirmed/.test(e.label)));
    assert.ok(!entries.some((e) => e.key === "A"));
  });

  test("a stretch with nothing scoreable says so instead of borrowing the other stretch's result", () => {
    const short = clip(400, [{ id: 2, from: 0, to: 30, x: () => 600, app: BEIGE }, { id: 4, from: 150, to: 300, x: () => 605, app: BEIGE }]);
    const rs = buildTracks(short);
    const p = presentTrack(rs.tracks[0], fakeScores(rs));
    assert.deepEqual(p.stretches.map((x) => x.score.kind), ["not-scoreable", "scored"]);
  });
});

describe("combined only when the identity holds", () => {
  test("a brief gap (confident link) is one stretch and one combined result", () => {
    const rb = buildTracks(clip(200, [{ id: 1, from: 0, to: 90, x: () => 300 }, { id: 2, from: 100, to: 200, x: () => 300 }]));
    const p = presentTrack(rb.tracks[0], fakeScores(rb));
    assert.equal(p.kind, "combined");
    assert.equal(p.confirmedByUser, false);
    assert.equal(p.score.result.windows.length, 3);
    assert.deepEqual(reviewTracks(rb.tracks[0], p).map((e) => e.key), ["A"]);
  });

  test("after the user confirms the uncertain link, the result is combined and marked as the user's call", () => {
    const rc = buildTracks(longGap, {}, { separate: [], merge: [], confirm: ["2>4"] });
    const t = rc.tracks[0];
    assert.deepEqual(t.links.map((l) => l.confidence), ["manual"]);
    const p = presentTrack(t, fakeScores(rc));
    assert.equal(p.kind, "combined");
    assert.equal(p.confirmedByUser, true);
    assert.equal(p.score.result.windows.length, 5);
    assert.equal(t.label, "A", "confirming doesn't rename the track");
  });

  test("separating instead gives two tracks, each with its own result", () => {
    const rsep = buildTracks(longGap, {}, { separate: ["2>4"], merge: [] });
    assert.deepEqual(rsep.tracks.map((t) => [t.label, presentTrack(t, fakeScores(rsep)).kind]), [["A", "combined"], ["B", "combined"]]);
  });

  test("results stay pending until every segment of a stretch is scored", () => {
    const r = buildTracks(longGap);
    const partial = fakeScores(r);
    delete partial[segKey(segmentsToScore(r.tracks[0]).find((s) => s.part === "4"))];
    const p = presentTrack(r.tracks[0], partial);
    assert.deepEqual(p.stretches.map((x) => x.score.kind), ["scored", "pending"]);
  });
});
