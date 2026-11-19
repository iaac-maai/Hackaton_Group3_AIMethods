// Draft schedule planner: suggestions follow only the user's inputs; editing is immutable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addBlock, dayTotals, formatTime, generateDay, generatePlan, moveBlock, orderTasks, parseTime, planToText,
  removeBlock, updateBlock, validate, withTimes,
} from "../src/schedule.ts";

const S = { startMin: 7 * 60, endMin: 15 * 60 + 30, shortBreakMin: 10, workStretchMin: 90, mealBreakMin: 30, alternate: false };
const task = (id, name, minutes, demanding = false) => ({ id, name, minutes, demanding });
const kinds = (p) => p.blocks.map((b) => b.kind).join(",");

describe("time helpers", () => {
  test("parse / format", () => {
    assert.equal(parseTime("07:30"), 450);
    assert.equal(parseTime("7:05"), 425);
    assert.equal(parseTime("24:00"), null);
    assert.equal(parseTime("x"), null);
    assert.equal(formatTime(930), "15:30");
  });
});

describe("validate", () => {
  test("plain-language problems", () => {
    assert.deepEqual(validate(S, [task("a", "Dig", 60)]), []);
    assert.match(validate({ ...S, endMin: S.startMin }, [task("a", "Dig", 60)])[0], /later than the start/);
    assert.match(validate(S, [task("a", "  ", 60)])[0], /at least one task/);
    assert.match(validate({ ...S, workStretchMin: 5 }, [task("a", "Dig", 60)])[0], /15 minutes/);
  });
});

describe("generateDay", () => {
  test("breaks after each work stretch, one meal near the middle, open time at the end", () => {
    const p = generateDay("Day", S, [task("a", "Formwork", 180), task("b", "Rebar", 120), task("c", "Cleanup", 60)]);
    const t = withTimes(p.blocks, S.startMin);
    // no work stretch longer than 90 min
    let run = 0;
    for (const b of t) { run = b.kind === "task" ? run + b.minutes : 0; assert.ok(run <= 90, `stretch ${run}`); }
    const meals = t.filter((b) => b.kind === "meal");
    assert.equal(meals.length, 1);
    const mid = (S.startMin + S.endMin) / 2;
    assert.ok(Math.abs(meals[0].start - mid) <= 90, `meal at ${formatTime(meals[0].start)}`);
    assert.equal(t.at(-1).end, S.endMin, "fills exactly to the shift end");
    assert.equal(p.blocks.filter((b) => b.kind === "task").reduce((a, b) => a + b.minutes, 0), 360, "all task time kept");
    assert.deepEqual(p.unscheduled, []);
    assert.ok(p.blocks.some((b) => /Formwork \(part 1 of 2\)/.test(b.label)), "long task split and labelled");
  });

  test("never ends on a break; leftover becomes open time", () => {
    const p = generateDay("Day", S, [task("a", "Survey", 90)]);
    assert.equal(kinds(p), "task,open");
  });

  test("task time that doesn't fit is reported, not dropped silently", () => {
    const p = generateDay("Day", { ...S, endMin: S.startMin + 120 }, [task("a", "Pour", 100), task("b", "Finish", 60)]);
    assert.ok(dayTotals(p.blocks, { ...S, endMin: S.startMin + 120 }).overrunMin === 0);
    assert.equal(p.unscheduled.reduce((a, u) => a + u.minutes, 0) + p.blocks.filter((b) => b.kind === "task").reduce((a, b) => a + b.minutes, 0), 160);
    assert.ok(p.unscheduled.length >= 1);
  });

  test("no meal break when set to 0", () => {
    const p = generateDay("Day", { ...S, mealBreakMin: 0 }, [task("a", "Dig", 400)]);
    assert.ok(!p.blocks.some((b) => b.kind === "meal"));
  });
});

describe("orderTasks", () => {
  test("alternates demanding and lighter tasks, keeping each group's order", () => {
    const ts = [task("1", "Lift A", 30, true), task("2", "Lift B", 30, true), task("3", "Check", 30), task("4", "Log", 30)];
    assert.deepEqual(orderTasks(ts, true).map((t) => t.name), ["Lift A", "Check", "Lift B", "Log"]);
    assert.deepEqual(orderTasks(ts, false).map((t) => t.name), ["Lift A", "Lift B", "Check", "Log"]);
  });
});

describe("week + editing", () => {
  test("one plan per chosen day, independent blocks", () => {
    const plan = generatePlan(["Mon", "Wed"], S, [task("a", "Dig", 120)]);
    assert.deepEqual(plan.map((d) => d.day), ["Mon", "Wed"]);
    assert.notEqual(plan[0].blocks[0].id, plan[1].blocks[0].id);
  });

  test("change, move, remove, add — without mutating", () => {
    const p = generateDay("Day", S, [task("a", "Dig", 120), task("b", "Haul", 60)]);
    const before = JSON.stringify(p.blocks);
    const id = p.blocks[0].id;
    const changed = updateBlock(p.blocks, id, { label: "Dig trench", minutes: 45 });
    assert.equal(changed[0].label, "Dig trench");
    assert.equal(withTimes(changed, S.startMin)[1].start, S.startMin + 45, "later blocks move");
    assert.equal(moveBlock(p.blocks, id, 1)[1].id, id);
    assert.equal(moveBlock(p.blocks, id, -1), p.blocks, "can't move past the start");
    assert.ok(!removeBlock(p.blocks, id).some((b) => b.id === id));
    assert.equal(addBlock(p.blocks, "break", 10).at(-1).kind, "break");
    assert.equal(JSON.stringify(p.blocks), before);
  });

  test("overrun is reported when edits run past the shift end", () => {
    const p = generateDay("Day", S, [task("a", "Dig", 120)]);
    const longer = addBlock(p.blocks, "task", 60);
    assert.equal(dayTotals(longer, S).overrunMin, 60);
  });

  test("text copy is labelled as a draft", () => {
    const txt = planToText(generatePlan(["Mon"], S, [task("a", "Dig", 60)]), S);
    assert.match(txt, /draft, not a final or approved schedule/);
    assert.match(txt, /Monday · shift 07:00–15:30/);
    assert.match(txt, /07:00–08:00 {2}Dig/);
  });
});

describe("review rules and reasons", () => {
  const base = { ...S, alternate: true };
  test("a task rated Hard gets shorter stretches, and the break says why", () => {
    const p = generateDay("Day", { ...base, hardStretchMin: 60 }, [task("a", "Rebar", 150, true)].map((t) => ({ ...t, exertion: "hard" })));
    const t = withTimes(p.blocks, S.startMin);
    let run = 0;
    for (const b of t) { run = b.kind === "task" ? run + b.minutes : 0; assert.ok(run <= 60, `stretch ${run}`); }
    const br = p.blocks.find((b) => b.kind === "break");
    assert.match(br.reason, /Rebar is rated Hard or Very hard in the shift review; your rule for tasks rated Hard or Very hard: at most 60 min of continuous work/);
    assert.match(p.blocks[0].reason, /Rated Hard in the shift review/);
  });
  test("after the reported tiredness time, breaks come more often", () => {
    const s = { ...base, tiredFromMin: 11 * 60, tiredStretchMin: 60 };
    const p = generateDay("Day", s, [task("a", "Haul", 400)]);
    const t = withTimes(p.blocks, S.startMin);
    const late = t.filter((b) => b.kind === "break" && b.start >= 11 * 60);
    assert.ok(late.length && late.every((b) => /your rule after reported tiredness: a break every 60 min of work around and after 11:00/.test(b.reason)), JSON.stringify(late.map((b) => b.reason)));
    // no work stretch that ends after 11:00 is longer than 60 min (or than the time up to 11:00)
    let run = 0, runStart = S.startMin;
    for (const b of t) {
      if (b.kind === "task") { if (!run) runStart = b.start; run += b.minutes; } else run = 0;
      if (b.kind === "task" && b.end > 11 * 60) assert.ok(run <= Math.max(60, 11 * 60 - runStart), `stretch ${run} min ending ${b.end}`);
    }
  });
  test("a stretch that starts before the tiredness time is still capped", () => {
    const s = { ...base, mealBreakMin: 0, tiredFromMin: 8 * 60, tiredStretchMin: 60 };
    const p = generateDay("Day", s, [task("a", "Haul", 200)]);
    const t = withTimes(p.blocks, S.startMin);
    assert.equal(t[0].end, 8 * 60, "the 07:00 stretch stops at 08:00 instead of running 90 min");
  });
  test("without review rules every block still explains itself; edits replace the reason", () => {
    const p = generateDay("Day", base, [task("a", "Lift", 100, true), task("b", "Check", 60)]);
    assert.ok(p.blocks.every((b) => b.reason));
    assert.match(p.blocks.find((b) => b.label === "Check").reason, /Lighter task placed after a demanding one \(Lift\)/);
    assert.match(p.blocks.find((b) => b.kind === "break").reason, /your break rule: a break after every 90 min/);
    assert.equal(updateBlock(p.blocks, p.blocks[0].id, { minutes: 30 })[0].reason, "Changed by you.");
    assert.equal(moveBlock(p.blocks, p.blocks[0].id, 1)[1].reason, "Moved by you.");
  });
  test("text export includes the basis and the reasons", () => {
    const txt = planToText(generatePlan(["Day"], S, [task("a", "Dig", 60)]), S, { title: "General schedule template (not personalised)", notes: ["Missing: x"] });
    assert.match(txt, /General schedule template \(not personalised\)\n- Missing: x/);
    assert.match(txt, /Why: First task of the shift\./);
    assert.match(txt, /not medical advice, a diagnosis, an injury-risk assessment or a safety certification/i);
  });
});

describe("configurable review rules", () => {
  const hardTask = (min) => [{ ...task("a", "Rebar", min, true), exertion: "very-hard" }];
  const longest = (p) => { let run = 0, max = 0; for (const b of p.blocks) { run = b.kind === "task" ? run + b.minutes : 0; max = Math.max(max, run); } return max; };
  test("user-set values are used, not a fixed 60", () => {
    const p = generateDay("Day", { ...S, mealBreakMin: 0, hardStretchMin: 45 }, hardTask(180));
    assert.equal(longest(p), 45);
    assert.match(p.blocks.find((b) => b.kind === "break").reason, /at most 45 min of continuous work/);
    const q = generateDay("Day", { ...S, mealBreakMin: 0, tiredFromMin: 7 * 60, tiredStretchMin: 40 }, [task("a", "Haul", 200)]);
    assert.equal(longest(q), 40);
    assert.match(q.blocks.find((b) => b.kind === "break").reason, /a break every 40 min of work around and after 07:00/);
  });
  test("a rule that is off (undefined) has no effect", () => {
    const p = generateDay("Day", { ...S, mealBreakMin: 0 }, hardTask(180));
    assert.equal(longest(p), 90, "only the general 90-min break rule applies");
    assert.ok(!p.blocks.some((b) => /Hard-task rule|tasks rated Hard/.test(b.reason ?? "") && b.kind === "break"));
  });
  test("each split part names the rule that caused it", () => {
    const p = generateDay("Day", { ...S, mealBreakMin: 0, hardStretchMin: 60 }, hardTask(150));
    const parts = p.blocks.filter((b) => b.kind === "task");
    assert.match(parts[0].reason, /Split into 3 parts by your Hard-task rule \(at most 60 min\)/);
    assert.match(parts[1].reason, /Continues Rebar after the break \(split by your Hard-task rule \(at most 60 min\)\)/);
    const g = generateDay("Day", { ...S, mealBreakMin: 0 }, [task("a", "Dig", 150)]);
    assert.match(g.blocks.find((b) => b.kind === "task").reason, /Split into 2 parts by your break rule \(every 90 min\)/);
  });
});
