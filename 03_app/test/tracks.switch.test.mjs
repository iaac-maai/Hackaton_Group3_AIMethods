// EXPERIMENTAL multi-person: identity switches inside one tracker ID must never reach the scoring API
// as one segment. Located switches are split (the band around the change isn't scored); switches that
// can't be located withhold every segment overlapping them. All data here is synthetic; the 4.03.35
// case is a replica of the reported clip built from its measured values (no real keypoints).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTracks, describeIssues, segmentFrames, segmentsToScore, withheldSegments } from "../src/pose/tracks.ts";

const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
function body(cx, cy, p = 0.9) {
  const f = empty().map(() => [cx, cy - 50, p]);
  f[5] = [cx - 20, cy - 100, p]; f[6] = [cx + 20, cy - 100, p];
  f[11] = [cx - 15, cy, p]; f[12] = [cx + 15, cy, p];
  return f;
}
/** people: [{id, from, to, x(t), app(t) | null}] */
function clip(T, people) {
  return Array.from({ length: T }, (_, t) => people
    .filter((p) => t >= p.from && t < p.to)
    .map((p) => ({ id: p.id, score: 0.8, kp: body(p.x(t), 500), app: p.app?.(t) ?? null })));
}
// Clothing colours (torso RGB, thigh RGB) as measured on 4.03.35: light sweater + light trousers, pink top + dark trousers, black jacket.
const LIGHT = [0.66, 0.63, 0.66, 0.6, 0.59, 0.66];
const PINK = [0.83, 0.69, 0.69, 0.13, 0.13, 0.18];
const BLACK = [0.07, 0.06, 0.11, 0.16, 0.14, 0.2];

/** What the app sends: every segment from segmentsToScore(), as segmentFrames() builds it. Records which person each sent frame shows. */
function sentForScoring(poses, result) {
  const sent = [];
  for (const t of result.tracks) {
    for (const s of segmentsToScore(t)) {
      const frames = segmentFrames(t, s, empty);
      const colours = new Set();
      frames.forEach((f, i) => {
        if (f[11][2] === 0) return;
        const p = poses[s.start + i].find((q) => q.id === s.rawId);
        colours.add(JSON.stringify(p.app));
      });
      sent.push({ track: t.label, part: s.part, start: s.start, end: s.end, colours: colours.size });
    }
  }
  return sent;
}

describe("a switch that can be located is split before scoring", () => {
  // Tracker 1 follows the person in light clothes, then jumps to the person in pink at frame 100.
  const poses = clip(200, [{ id: 1, from: 0, to: 200, x: () => 300, app: (t) => (t < 100 ? LIGHT : PINK) }]);
  const r = buildTracks(poses);

  test("the tracker ID is cut at the switch into two tracks; the band around it isn't in any segment", () => {
    assert.deepEqual(r.tracks.map((t) => [t.label, t.parts]), [["A", ["1"]], ["B", ["1#2"]]]);
    const sw = r.tracks[0].issues.find((i) => i.kind === "appearance-change");
    assert.equal(sw.located, true);
    assert.ok(sw.start <= 100 && sw.end > 100 && sw.end - sw.start <= 12, `band ${sw.start}-${sw.end}`);
    for (const t of r.tracks) for (const s of t.segments) assert.ok(s.end <= sw.start || s.start >= sw.end, `segment ${s.start}-${s.end} overlaps the switch`);
    // the part after the switch looks different, so it isn't joined back automatically
    assert.ok(r.tracks[1].issues.some((i) => i.kind === "possible-same" && i.of === "A" && i.why === "looks-different"));
  });

  test("every segment sent for scoring shows one person", () => {
    const sent = sentForScoring(poses, r);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => s.colours === 1), JSON.stringify(sent));
  });

  test("both tracks carry the switch warning and are identity uncertain", () => {
    for (const t of r.tracks) {
      assert.equal(t.identity, "uncertain");
      assert.ok(describeIssues(t, 200).some((w) => /probably switched to another person\. The tracking was split there/.test(w)));
    }
  });

  test("the part after a switch can still be joined to the person it really is", () => {
    // Light-clothed person tracked as 2, tracker jumps to the person in pink at 60; pink is re-found as 4 later.
    const p2 = clip(300, [
      { id: 2, from: 0, to: 110, x: () => 400, app: (t) => (t < 60 ? LIGHT : PINK) },
      { id: 4, from: 170, to: 300, x: () => 405, app: () => PINK },
    ]);
    const r2 = buildTracks(p2);
    assert.deepEqual(r2.tracks.map((t) => [t.label, t.parts]), [["A", ["2"]], ["B", ["2#2", "4"]]]);
    assert.ok(sentForScoring(p2, r2).every((s) => s.colours === 1));
  });
});

describe("a switch that can't be located withholds the segment", () => {
  // Replica of 4.03.35 at 320 px: tracker 2 (frames 3–68) starts on the woman in light clothes and ends on
  // the woman in pink about 10 frames before it stops, so the switch runs into the end of the fragment.
  // The pink woman is re-found as tracker 4 at frame 188; the man (tracker 1) is in view throughout.
  const poses = clip(214, [
    { id: 1, from: 0, to: 214, x: () => 150, app: () => BLACK },
    { id: 2, from: 3, to: 69, x: (t) => 393 - (t - 3) * 0.65, app: (t) => (t < 58 ? LIGHT : PINK) },
    { id: 4, from: 188, to: 214, x: () => 360, app: () => PINK },
  ]);
  const r = buildTracks(poses);
  const b = r.tracks.find((t) => t.rawIds.includes(2));

  test("the mixed segment is withheld, with the reason and times", () => {
    assert.deepEqual(b.parts, ["2", "4"]);
    const sw = b.issues.find((i) => i.kind === "appearance-change");
    assert.equal(sw.located, false);
    assert.deepEqual(withheldSegments(b).map((s) => [s.part, s.start, s.end]), [["2", 3, 69]]);
    assert.match(withheldSegments(b)[0].withheld, /may have switched to another person/);
    assert.equal(b.scoreable, false);
    assert.ok(describeIssues(b, 214).some((w) => /Not scored \(may contain two people\): 0:00\.1–0:02\.8/.test(w)));
  });

  test("the withheld segment never reaches the scoring API", () => {
    const sent = sentForScoring(poses, r);
    assert.deepEqual(sent.map((s) => [s.track, s.part]), [["A", "1"]]);
    assert.throws(() => segmentFrames(b, withheldSegments(b)[0], empty), /withheld from scoring/);
  });

  test("a colour change spread over more than 1 s (sparse colour data) is not located either", () => {
    // Colour known only every 3rd frame: the change can only be placed within about 30 frames.
    const p2 = clip(240, [{ id: 1, from: 0, to: 240, x: () => 300, app: (t) => (t % 3 ? null : t < 120 ? LIGHT : PINK) }]);
    const r2 = buildTracks(p2);
    assert.equal(r2.tracks.length, 1);
    assert.equal(r2.tracks[0].issues.find((i) => i.kind === "appearance-change").located, false);
    assert.deepEqual(sentForScoring(p2, r2), []);
    assert.equal(withheldSegments(r2.tracks[0]).length, 1);
  });
});

describe("manual edits don't erase an unresolved switch", () => {
  test("merging the two sides of a located switch keeps the warning and keeps them in separate segments", () => {
    const poses = clip(200, [{ id: 1, from: 0, to: 200, x: () => 300, app: (t) => (t < 100 ? LIGHT : PINK) }]);
    const m = buildTracks(poses, {}, { separate: [], merge: [["1", "1#2"]] });
    assert.deepEqual(m.tracks.map((t) => [t.label, t.parts]), [["A", ["1", "1#2"]]]);
    const a = m.tracks[0];
    assert.equal(a.identity, "uncertain");
    assert.ok(a.issues.some((i) => i.kind === "appearance-change" && i.located));
    assert.ok(a.links.some((l) => l.confidence === "manual"));
    assert.ok(sentForScoring(poses, m).every((s) => s.colours === 1));
  });

  test("separating and merging back a withheld track keeps it withheld", () => {
    const poses = clip(214, [
      { id: 1, from: 0, to: 214, x: () => 150, app: () => BLACK },
      { id: 2, from: 3, to: 69, x: (t) => 393 - (t - 3) * 0.65, app: (t) => (t < 58 ? LIGHT : PINK) },
      { id: 4, from: 188, to: 214, x: () => 360, app: () => PINK },
    ]);
    for (const edits of [{ separate: ["2>4"], merge: [] }, { separate: ["2>4"], merge: [[4, 2]] }]) {
      const r = buildTracks(poses, {}, edits);
      const t = r.tracks.find((x) => x.rawIds.includes(2));
      assert.ok(t.issues.some((i) => i.kind === "appearance-change" && !i.located), JSON.stringify(edits));
      assert.equal(withheldSegments(t).length, 1);
      assert.deepEqual(sentForScoring(poses, r).map((s) => s.part), ["1"]);
    }
  });
});

test("steady clothing colour: no switch, nothing withheld", () => {
  const poses = clip(200, [{ id: 1, from: 0, to: 200, x: () => 300, app: (t) => LIGHT.map((v, i) => v + 0.04 * Math.sin(t / 3 + i)) }]);
  const r = buildTracks(poses);
  assert.equal(r.tracks.length, 1);
  assert.ok(!r.tracks[0].issues.some((i) => i.kind === "appearance-change"));
  assert.deepEqual(withheldSegments(r.tracks[0]), []);
});
