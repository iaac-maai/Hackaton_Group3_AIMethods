// Shift review: worker grouping and confirmation, review -> planner inputs, and the "not enough
// information" path. Movement-deviation results must never become planning inputs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { groupWorkers, planFromReview, workerKey } from "../src/review.ts";

let n = 0;
const id = () => `x${++n}`;
const clipA = { id: "c1", name: "morning.mp4", durationS: 12, source: "multi",
  tracks: [{ key: "A", label: "Track A", scored: true, windows: 5, aboveTrained: 4 }, { key: "B", label: "Track B", scored: false, windows: 0, aboveTrained: 0 }] };
const clipB = { id: "c2", name: "afternoon.mp4", durationS: 9, source: "single",
  tracks: [{ key: "single", label: "Person (single-person analysis)", scored: true, windows: 4, aboveTrained: 0 }] };
const entry = (o) => ({ id: id(), clipId: "c1", trackKey: "A", worker: "Ana", task: "", timeInShift: "", minutes: null, exertion: "", fatigue: "", ...o });

describe("grouping", () => {
  test("by worker name (trimmed, case-insensitive); unnamed entries are left out", () => {
    const g = groupWorkers([entry({ worker: " ana " }), entry({ worker: "ANA", clipId: "c2", trackKey: "single" }), entry({ worker: "" })]);
    assert.equal(g.length, 1);
    assert.equal(workerKey(" Ana  B "), "ana b");
    assert.equal(g[0].entries.length, 2);
    assert.equal(g[0].needsConfirmation, true, "two clips for one worker need confirmation");
  });
  test("one clip/track for a worker needs no confirmation; Track A in two clips does", () => {
    assert.equal(groupWorkers([entry({})])[0].needsConfirmation, false);
    const two = groupWorkers([entry({}), entry({ clipId: "c2", trackKey: "A" })])[0];
    assert.equal(two.needsConfirmation, true, "same track label in different videos is not assumed to be the same person");
  });
});

describe("planFromReview", () => {
  test("nothing reviewed -> general template with what is missing", () => {
    const p = planFromReview(null, [], new Set(), id);
    assert.equal(p.personalized, false);
    assert.match(p.missing[0], /Add at least one analysed clip/);
  });

  test("task + duration but no self-report -> not personalised; video is not used to fill the gap", () => {
    const g = groupWorkers([entry({ task: "Rebar tying", minutes: 120 })])[0];
    const p = planFromReview(g, [clipA], new Set(), id);
    assert.equal(p.personalized, false);
    assert.ok(p.missing.some((m) => /own exertion or tiredness rating/.test(m) && /doesn’t infer these from video/.test(m)));
    assert.equal(p.tasks.length, 1, "tasks are still collected");
    assert.equal(p.tasks[0].demanding, false, "4 of 5 windows above threshold does NOT make a task demanding");
  });

  test("self-reported exertion makes a task demanding; tiredness with a time sets the tired-from rule", () => {
    const g = groupWorkers([
      entry({ task: "Rebar tying", minutes: 120, exertion: "hard" }),
      entry({ task: "Site check", minutes: 60, exertion: "light", fatigue: "quite", timeInShift: "13:30", trackKey: "B" }),
    ])[0];
    const p = planFromReview(g, [clipA], new Set(), id);
    assert.equal(p.personalized, false, "two tracks of one video for one worker -> must confirm first");
    assert.ok(p.missing.some((m) => /all show the same person/.test(m)));
    const ok = planFromReview(g, [clipA], new Set([g.signature]), id);
    assert.equal(ok.personalized, true);
    assert.deepEqual(ok.tasks.map((t) => [t.name, t.minutes, t.demanding, t.exertion]), [["Rebar tying", 120, true, "hard"], ["Site check", 60, false, "light"]]);
    assert.equal(ok.tiredFromMin, 13 * 60 + 30);
    assert.ok(ok.basis.some((b) => /Movement-deviation results were not used/.test(b)));
    assert.ok(ok.context.some((c) => /4 of 5 scored windows above the trained threshold/.test(c)), "deviation is kept as context only");
  });

  test("same task in two clips: longest duration, highest exertion; unusable inputs are reported", () => {
    const g = groupWorkers([
      entry({ task: "Lifting", minutes: 60, exertion: "moderate" }),
      entry({ task: "lifting", minutes: 90, exertion: "very-hard", clipId: "c2", trackKey: "single" }),
      entry({ task: "Cleanup", clipId: "c2", trackKey: "single", fatigue: "very" }),
    ])[0];
    const p = planFromReview(g, [clipA, clipB], new Set([g.signature]), id);
    assert.deepEqual(p.tasks.map((t) => [t.minutes, t.exertion]), [[90, "very-hard"]]);
    assert.ok(p.gaps.some((x) => /“Cleanup” has no approximate duration/.test(x)));
    assert.ok(p.gaps.some((x) => /tiredness report for “Cleanup” has no time/.test(x)));
    assert.equal(p.tiredFromMin, null);
    assert.equal(p.personalized, true, "exertion was reported, so the draft can be personalised");
  });
});
