// Regression: two workers at a brick wall (stock clip 11355903-uhd_3840_2160_25fps.mp4, 16 s).
// test/fixtures/two_workers_wall.json holds MoveNet MultiPose detections (256 px, bounding-box
// tracker) captured through the app's own video path with tools/capture_multi_fixture.mjs; no pixels.
//
// Before the fix the app showed three tracks for two people: Track A in 4% of the clip (the right
// worker's first 1.8 s), Track B from 0:02.8 (the same worker again) and Track C from 0:05.7 (the
// left worker, whose first 0.4 s were dropped as a "brief detection"). Detection scores here sit at
// 0.25–0.33, right at MoveNet's 0.25 cut-off, so the tracker loses both workers for long stretches.
//
// Re-capture after a detector change: npm run build, then
//   node tools/capture_multi_fixture.mjs --video <clip> --out test/fixtures/two_workers_wall.json
//
// PRIVACY: these fixtures hold real people's keypoints and clothing colours. They are kept local
// (not in Git) until sharing is confirmed, so every test here SKIPS when its fixture is missing.
// The synthetic tests (tracks.test.mjs, tracks.identity.test.mjs, tracks.switch.test.mjs) cover the
// same behaviour without real data.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildTracks, describeIssues, identityStretches, presentTrack, reviewTracks, segmentFrames, segmentsToScore, trackTimes, withheldSegments } from "../src/pose/tracks.ts";

const load = (name) => {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  if (!existsSync(url)) return null;
  return JSON.parse(readFileSync(url, "utf8")).frames.map((ps) => ps.map(([id, score, kp, app]) => ({ id, score, kp, app })));
};
const missing = (name) => `local fixture test/fixtures/${name} not present (kept out of Git for privacy)`;

const WALL = "two_workers_wall.json";
const poses = load(WALL) ?? [];
const T = poses.length;
// Tracker IDs in this capture: 1 and 3 are the right worker (blue shirt), 2 and 4 the left worker (at the mixer).
const RIGHT = [1, 3], LEFT = [2, 4];
const trackOf = (r, rawId) => r.tracks.find((t) => t.rawIds.includes(rawId));
const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);

describe("two workers at a brick wall (recorded clip)", { skip: T ? false : missing(WALL) }, () => {
  const r = buildTracks(poses);

  test("no identity switch is flagged and nothing is withheld; every segment sent shows one tracker ID", () => {
    assert.ok(r.tracks.every((t) => !t.issues.some((i) => i.kind === "appearance-change")));
    assert.ok(r.tracks.every((t) => withheldSegments(t).length === 0));
    assert.deepEqual(r.tracks.map((t) => segmentsToScore(t).map((s) => `${s.part}:${s.start}-${s.end}`)), [["3:190-262"], ["4:143-261"]]);
  });

  test("both tracks are joined across uncertain gaps, so neither gets a combined (confirmed-person) result", () => {
    for (const t of r.tracks) {
      assert.equal(identityStretches(t).length, 2, `Track ${t.label}`);
      const p = presentTrack(t, {});
      assert.equal(p.kind, "per-stretch");
      assert.ok(reviewTracks(t, p).every((e) => e.key.startsWith(`${t.label}.`) && /identity not confirmed/.test(e.label)));
    }
    const confirmed = buildTracks(poses, {}, { separate: [], merge: [], confirm: ["1>3", "2>4"] });
    assert.deepEqual(confirmed.tracks.map((t) => [t.label, presentTrack(t, {}).kind]), [["A", "combined"], ["B", "combined"]]);
  });

  test("the fixture still reproduces the original failure without linking", () => {
    assert.equal(T, 401);
    const old = buildTracks(poses, { relink: false });
    assert.equal(old.tracks.length, 3);
    assert.equal(Math.round((old.tracks[0].present / T) * 100), 4);
    assert.ok(old.brief.some((b) => b.rawId === 2), "the left worker's first fragment was dropped as brief");
  });

  test("two people become two tracks, not three", () => {
    assert.equal(r.tracks.length, 2, r.tracks.map((t) => `${t.label}[${t.rawIds}]`).join(" "));
    assert.equal(r.maxPeople, 2);
    assert.deepEqual(r.brief, []);
  });

  test("each worker's fragments are under one label, and the labels are A and B", () => {
    assert.deepEqual(trackOf(r, 1).rawIds, RIGHT);
    assert.deepEqual(trackOf(r, 2).rawIds, LEFT);
    assert.equal(trackOf(r, 1).label, "A");
    assert.equal(trackOf(r, 2).label, "B");
  });

  test("both workers, visible from the start, are tracked from the start (not only by a later fragment)", () => {
    for (const t of r.tracks) {
      assert.equal(t.first, 0, `Track ${t.label}`);
      assert.equal(trackTimes(t, T).firstSeen, "0:00.0");
    }
    assert.deepEqual(r.tracks.map((t) => trackTimes(t, T).lastSeen), ["0:16.0", "0:13.9"]);
  });

  test("the long gaps are shown as uncertain, with times", () => {
    const a = trackOf(r, 1), b = trackOf(r, 2);
    assert.deepEqual(a.links.map((l) => [l.key, l.confidence]), [["1>3", "uncertain"]]);
    assert.deepEqual(b.links.map((l) => [l.key, l.confidence]), [["2>4", "uncertain"]]);
    assert.deepEqual(trackTimes(a, T).uncertain.map((u) => [u.from, u.to]), [["0:01.8", "0:02.8"]]);
    assert.deepEqual(trackTimes(b, T).uncertain.map((u) => [u.from, u.to]), [["0:00.4", "0:05.7"]]);
    assert.ok(describeIssues(b, T).some((w) => /Identity uncertain 0:00.4–0:05.7/.test(w)));
    assert.ok(r.tracks.every((t) => t.identity === "uncertain"));
  });

  test("labels stay put when more detections are lost", () => {
    // Lose everyone for 0.4 s every 4 s, and the right worker for another 0.6 s after the first second.
    const lossy = poses.map((ps, t) => (t % 100 >= 60 && t % 100 < 70 ? [] : t >= 25 && t < 40 ? ps.filter((p) => p.id !== 1) : ps));
    const l = buildTracks(lossy);
    assert.equal(l.tracks.length, 2);
    assert.equal(trackOf(l, 3).label, "A");
    assert.equal(trackOf(l, 4).label, "B");
  });

  test("scored segments are unchanged: one tracker ID each, same as without linking", () => {
    const seg = (x) => x.tracks.flatMap((t) => t.segments.map((s) => `${s.rawId}:${s.start}-${s.end}:${s.scoreableWindows}`)).sort();
    assert.deepEqual(seg(r), seg(buildTracks(poses, { relink: false, minLabelFrames: 0 })));
    for (const t of r.tracks) for (const s of t.segments) {
      segmentFrames(t, s, empty).forEach((f, i) => {
        if (f[11][2] > 0) assert.deepEqual(f, poses[s.start + i].find((p) => p.id === s.rawId).kp);
      });
    }
  });

  test("the user can separate an uncertain link and merge it back; other labels don't move", () => {
    const sep = buildTracks(poses, {}, { separate: ["1>3"], merge: [] });
    assert.deepEqual(sep.tracks.map((t) => [t.label, t.rawIds]), [["A", [1]], ["B", LEFT], ["C", [3]]]);
    const back = buildTracks(poses, {}, { separate: ["1>3"], merge: [[3, 1]] });
    assert.deepEqual(back.tracks.map((t) => [t.label, t.rawIds]), [["A", RIGHT], ["B", LEFT]]);
    assert.equal(trackOf(back, 1).links[0].confidence, "manual");
    // Separating the left worker's 5.4 s gap leaves a 0.3 s first fragment, which is too short to label.
    const sepB = buildTracks(poses, {}, { separate: ["2>4"], merge: [] });
    assert.deepEqual(sepB.brief, [{ rawId: 2, frames: 8 }]);
  });
});

// Reported switch: 4.03.35 at 320 px (bounding-box tracker), captured through the app's video path.
// Tracker 2 starts on the woman in light clothes and ends on the woman in pink (about 0:02.1–0:02.8).
// Real people: local only, like the fixture above. tracks.switch.test.mjs has a synthetic replica.
const SWITCH = "switch_4.03.35_320.json";
const switchPoses = load(SWITCH);

describe("4.03.35: tracker 2 switches people (recorded clip)", { skip: switchPoses ? false : missing(SWITCH) }, () => {
  const r = buildTracks(switchPoses ?? []);
  const b = r.tracks.find((t) => t.rawIds.includes(2));

  test("the switch is flagged and the mixed segment is withheld, not scored", () => {
    const sw = b.issues.find((i) => i.kind === "appearance-change" && i.rawId === 2);
    assert.ok(sw, "switch flagged");
    assert.equal(sw.located, false, "it runs into the end of tracker 2, so its frame can't be pinned down");
    assert.deepEqual(withheldSegments(b).map((s) => [s.rawId, s.start, s.end]), [[2, 3, 69]]);
    assert.equal(b.identity, "uncertain");
  });

  test("no frame of tracker 2 is sent for scoring; the man's track still is", () => {
    const sent = r.tracks.flatMap((t) => segmentsToScore(t).map((s) => ({ t, s })));
    assert.deepEqual(sent.map(({ s }) => s.rawId), [1]);
    for (const { t, s } of sent) segmentFrames(t, s, empty);   // throws on a withheld segment
    assert.throws(() => segmentFrames(b, withheldSegments(b)[0], empty), /withheld/);
  });
});
