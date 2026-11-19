// EXPERIMENTAL multi-person identity: which tracker fragments are one person, and how sure we are.
// Brief occlusion, reappearance, duplicate detections, two people crossing, and user merge/separate.
// The recorded two-person regression clip is in tracks.regression.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTracks, describeIssues, trackTimes } from "../src/pose/tracks.ts";

const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
/** Upright skeleton with hips at (cx, cy) and a 100 px torso; conf p for all points. */
function body(cx, cy, p = 0.9) {
  const f = empty().map(() => [cx, cy - 50, p]);
  f[5] = [cx - 20, cy - 100, p]; f[6] = [cx + 20, cy - 100, p];
  f[11] = [cx - 15, cy, p]; f[12] = [cx + 15, cy, p];
  return f;
}
/** T frames; people: [{id, from, to, x(t), missing?, app?}] (app: clothing colour, 6 numbers) */
function clip(T, people) {
  return Array.from({ length: T }, (_, t) => people
    .filter((p) => t >= p.from && t < p.to && !(p.missing ?? []).includes(t))
    .map((p) => ({ id: p.id, score: 0.8, kp: body(p.x(t), 500), ...(p.app ? { app: p.app } : {}) })));
}
const labelOf = (r, rawId) => r.tracks.find((t) => t.rawIds.includes(rawId))?.label;

const BLUE = [0.05, 0.2, 0.55, 0.35, 0.4, 0.45];
const BEIGE = [0.75, 0.72, 0.65, 0.3, 0.3, 0.32];

describe("brief occlusion", () => {
  test("a tracker ID change over a brief gap keeps the label and is a confident link", () => {
    const r = buildTracks(clip(200, [
      { id: 1, from: 0, to: 200, x: () => 200 },
      { id: 2, from: 0, to: 80, x: () => 600 }, { id: 3, from: 92, to: 200, x: () => 600 },   // lost for 12 frames
    ]));
    assert.equal(r.tracks.length, 2);
    assert.equal(labelOf(r, 2), "B");
    assert.equal(labelOf(r, 3), "B");
    const b = r.tracks.find((t) => t.label === "B");
    assert.deepEqual(b.links.map((l) => [l.key, l.confidence, l.gap]), [["2>3", "confident", 12]]);
    assert.equal(b.identity, "confident");
  });

  test("labels are the same with and without a brief loss", () => {
    const people = [
      { id: 1, from: 0, to: 200, x: () => 200 }, { id: 2, from: 5, to: 200, x: () => 600 }, { id: 3, from: 30, to: 200, x: () => 1000 },
    ];
    const clean = buildTracks(clip(200, people));
    // person 1 is lost for 15 frames and comes back with a new tracker ID
    const lossy = buildTracks(clip(200, [{ ...people[0], to: 50 }, { id: 9, from: 65, to: 200, x: () => 200 }, people[1], people[2]]));
    assert.deepEqual(clean.tracks.map((t) => t.label), ["A", "B", "C"]);
    assert.deepEqual(lossy.tracks.map((t) => [t.label, t.rawIds]), [["A", [1, 9]], ["B", [2]], ["C", [3]]]);
  });

  test("a hand-over (new ID a few frames before the old one stops, same place) is linked", () => {
    const r = buildTracks(clip(150, [{ id: 1, from: 0, to: 80, x: () => 300 }, { id: 2, from: 77, to: 150, x: () => 300 }]));
    assert.equal(r.tracks.length, 1);
    assert.deepEqual(r.tracks[0].rawIds, [1, 2]);
    assert.equal(r.tracks[0].links[0].gap, 0);
  });
});

describe("reappearance", () => {
  test("a person visible from the start, then lost for 5 s at the same spot, keeps one label; the gap is marked uncertain", () => {
    const r = buildTracks(clip(400, [
      { id: 1, from: 0, to: 400, x: () => 1400, app: BLUE },
      { id: 2, from: 0, to: 9, x: () => 600, app: BEIGE },            // only 9 frames before the tracker loses this person
      { id: 4, from: 143, to: 350, x: () => 610, app: BEIGE },
    ]));
    assert.equal(r.tracks.length, 2);
    const b = r.tracks.find((t) => t.rawIds.includes(4));
    assert.deepEqual(b.rawIds, [2, 4]);
    assert.equal(b.first, 0, "represented from frame 0, not only by the later fragment");
    assert.equal(b.identity, "uncertain");
    assert.deepEqual(b.links.map((l) => [l.confidence, l.gapStart, l.frame]), [["uncertain", 9, 143]]);
    const times = trackTimes(b, 400);
    assert.deepEqual([times.firstSeen, times.lastSeen], ["0:00.0", "0:14.0"]);
    assert.deepEqual(times.uncertain.map((u) => [u.from, u.to]), [["0:00.4", "0:05.7"]]);
    assert.ok(describeIssues(b, 400).some((w) => /Identity uncertain 0:00.4–0:05.7/.test(w)));
  });

  test("someone in different clothes appearing where a person was lost is kept apart, with a hint", () => {
    const r = buildTracks(clip(300, [{ id: 1, from: 0, to: 100, x: () => 600, app: BEIGE }, { id: 2, from: 160, to: 300, x: () => 600, app: BLUE }]));
    assert.equal(r.tracks.length, 2);
    const b = r.tracks.find((t) => t.label === "B");
    assert.ok(b.issues.some((i) => i.kind === "possible-same" && i.of === "A" && i.why === "looks-different"));
    assert.ok(describeIssues(b, 300).some((w) => /clothing colours differ/.test(w)));
  });

  test("reappearing far from where the person was lost is a new track", () => {
    const r = buildTracks(clip(200, [{ id: 1, from: 0, to: 80, x: () => 100 }, { id: 2, from: 90, to: 200, x: () => 1500 }]));
    assert.equal(r.tracks.length, 2);
    assert.ok(r.tracks.every((t) => t.links.length === 0));
  });

  test("gaps beyond 10 s are never joined automatically", () => {
    const r = buildTracks(clip(500, [{ id: 1, from: 0, to: 100, x: () => 300 }, { id: 2, from: 360, to: 500, x: () => 300 }]));
    assert.equal(r.tracks.length, 2);
  });

  test("a clothing colour change inside one tracker ID is flagged as a possible switch", () => {
    const poses = clip(120, [{ id: 1, from: 0, to: 120, x: () => 300 }]);
    poses.forEach((ps, t) => ps.forEach((p) => { p.app = t < 60 ? BEIGE : BLUE; }));
    const r = buildTracks(poses);
    assert.ok(r.tracks[0].issues.some((i) => i.kind === "appearance-change" && i.frame === 60));
    assert.equal(r.tracks[0].identity, "uncertain");
  });
});

describe("duplicates", () => {
  test("two people side by side are not merged as duplicates", () => {
    const r = buildTracks(clip(100, [{ id: 1, from: 0, to: 100, x: () => 300, app: BLUE }, { id: 2, from: 0, to: 100, x: () => 345, app: BEIGE }]));
    assert.equal(r.tracks.length, 2);
    assert.ok(r.tracks.every((t) => !t.issues.some((i) => i.kind === "duplicate" || i.kind === "merged-duplicate")));
  });

  test("a duplicate while the person is also lost and re-found still gives one label", () => {
    const r = buildTracks(clip(200, [
      { id: 1, from: 0, to: 90, x: () => 300 }, { id: 2, from: 30, to: 70, x: () => 303 },   // duplicate
      { id: 3, from: 100, to: 200, x: () => 300 },                                         // same person after a short gap
    ]));
    assert.deepEqual(r.tracks.map((t) => [t.label, t.rawIds, t.absorbed]), [["A", [1, 3], [2]]]);
  });
});

describe("two people crossing", () => {
  const walkers = (lost) => clip(100, [
    { id: 1, from: 0, to: lost ? 35 : 100, x: (t) => 300 + 5 * t, app: BLUE },
    { id: 2, from: 0, to: lost ? 35 : 100, x: (t) => 700 - 5 * t, app: BLUE },   // same clothes: only motion tells them apart
    ...(lost ? [{ id: 3, from: 50, to: 100, x: (t) => 300 + 5 * t, app: BLUE }, { id: 4, from: 50, to: 100, x: (t) => 700 - 5 * t, app: BLUE }] : []),
  ]);

  test("tracker keeps both IDs: two tracks, no duplicate", () => {
    const r = buildTracks(walkers(false));
    assert.deepEqual(r.tracks.map((t) => [t.label, t.rawIds, t.absorbed]), [["A", [1], []], ["B", [2], []]]);
    assert.ok(r.tracks.every((t) => !t.issues.some((i) => i.kind === "duplicate")));
  });

  test("both lost while crossing: each is linked by its direction of motion", () => {
    const r = buildTracks(walkers(true));
    assert.deepEqual(r.tracks.map((t) => [t.label, t.rawIds]), [["A", [1, 3]], ["B", [2, 4]]]);
    assert.ok(r.tracks.every((t) => t.links[0].confidence === "confident"));
  });

  test("two standing people, one re-found between them: not guessed, both offered for merging", () => {
    const r = buildTracks(clip(200, [
      { id: 1, from: 0, to: 80, x: () => 500 }, { id: 2, from: 0, to: 80, x: () => 560 },
      { id: 3, from: 95, to: 200, x: () => 530 },
    ]));
    const c = r.tracks.find((t) => t.rawIds.includes(3));
    assert.deepEqual(c.rawIds, [3]);
    assert.equal(c.identity, "uncertain");
    assert.deepEqual(c.issues.filter((i) => i.kind === "possible-same").map((i) => [i.of, i.why]).sort(), [["A", "ambiguous"], ["B", "ambiguous"]]);
  });
});

describe("user edits", () => {
  const poses = clip(400, [
    { id: 1, from: 0, to: 400, x: () => 1400 },
    { id: 2, from: 0, to: 20, x: () => 600 }, { id: 4, from: 143, to: 350, x: () => 610 },
    { id: 7, from: 50, to: 400, x: () => 200 },
  ]);

  test("separating an uncertain link keeps the other labels; the split-off part gets a new letter", () => {
    const auto = buildTracks(poses);
    assert.deepEqual(auto.tracks.map((t) => [t.label, t.rawIds]), [["A", [1]], ["B", [2, 4]], ["C", [7]]]);
    const sep = buildTracks(poses, {}, { separate: ["2>4"], merge: [] });
    assert.deepEqual(sep.tracks.map((t) => [t.label, t.rawIds]), [["A", [1]], ["B", [2]], ["C", [7]], ["D", [4]]]);
  });

  test("merging two tracks joins them under the earlier label and marks the join as yours", () => {
    const merged = buildTracks(poses, {}, { separate: ["2>4"], merge: [[4, 2]] });
    const b = merged.tracks.find((t) => t.label === "B");
    assert.deepEqual(b.rawIds, [2, 4]);
    assert.equal(b.links[0].confidence, "manual");
    assert.ok(describeIssues(b, 400).some((w) => /You joined two tracks/.test(w)));
    assert.deepEqual(merged.tracks.map((t) => t.label), ["A", "B", "C"]);
  });

  test("edits never change what a scored segment contains", () => {
    const seg = (r) => r.tracks.flatMap((t) => t.segments.map((s) => `${s.rawId}:${s.start}-${s.end}`)).sort();
    assert.deepEqual(seg(buildTracks(poses, {}, { separate: ["2>4"], merge: [] })), seg(buildTracks(poses)));
  });
});
