// Analytics dashboard calculations and client (no Worker): totals, per-period buckets with gaps,
// type breakdown, retention-limit and mixed-scoring notices, plain-language summaries, and that the
// client sends only the session cookie (no user/browser ID, no video, keypoints or file names).
// Dates are built with the local Date constructor so the tests pass in any time zone.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AnalyticsError, bucketize, bucketStart, chooseGranularity, computeAnalytics, describeAnalytics, describeTrend, loadAnalytics,
} from "../src/analytics.ts";

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const rec = (created_at, window_count, flagged_count, extra = {}) => ({
  created_at, analysis_type: "video", duration_seconds: 10, window_count, flagged_count,
  flagged_percent: Math.round((flagged_count / window_count) * 10000) / 100,
  model: "keypoint_autoencoder", threshold: 0.42, ...extra,
});
const data = (records, retention_limit = 100) => ({ records, retention_limit });

describe("totals", () => {
  test("window-weighted flagged share, per-analysis mean, durations", () => {
    const a = computeAnalytics(data([
      rec(at(2026, 11, 3), 10, 5),
      rec(at(2026, 11, 4), 30, 0, { duration_seconds: null }),
    ]));
    assert.equal(a.totals.analyses, 2);
    assert.equal(a.totals.windows, 40);
    assert.equal(a.totals.flaggedWindows, 5);
    assert.equal(a.totals.flaggedPercent, 12.5, "5 of 40 windows, not the mean of 50% and 0%");
    assert.equal(a.totals.meanAnalysisPercent, 25);
    assert.equal(a.totals.analysesWithFlags, 1);
    assert.equal(a.totals.durationSeconds, 10);
    assert.equal(a.totals.unknownDurations, 1);
    assert.equal(a.totals.first.getDate(), 3);
    assert.equal(a.totals.last.getDate(), 4);
  });

  test("no records: zeroes and nulls, no buckets", () => {
    const a = computeAnalytics(data([]));
    assert.equal(a.totals.analyses, 0);
    assert.equal(a.totals.flaggedPercent, null);
    assert.equal(a.totals.meanAnalysisPercent, null);
    assert.deepEqual(a.buckets, []);
    assert.equal(a.atRetentionLimit, false);
    assert.equal(describeAnalytics(a), "You have no saved analyses yet.");
  });

  test("records arrive in any order; invalid dates are ignored", () => {
    const a = computeAnalytics(data([rec(at(2026, 11, 5), 4, 1), rec("not a date", 9, 9), rec(at(2026, 11, 1), 4, 0)]));
    assert.equal(a.totals.analyses, 2);
    assert.equal(a.totals.first.getDate(), 1);
    assert.equal(a.totals.last.getDate(), 5);
  });
});

describe("periods", () => {
  test("granularity: days up to a month, weeks up to ~6 months, then months", () => {
    const d = (m, day) => new Date(2026, m - 1, day);
    assert.equal(chooseGranularity(d(1, 1), d(1, 31)), "day");
    assert.equal(chooseGranularity(d(1, 1), d(3, 1)), "week");
    assert.equal(chooseGranularity(d(1, 1), d(12, 1)), "month");
  });

  test("weeks start on Monday; months on the 1st", () => {
    const thu = new Date(2026, 10, 19, 15);   // Thursday 19 Nov 2026
    const wk = bucketStart(thu, "week");
    assert.equal(wk.getDay(), 1);
    assert.equal(wk.getDate(), 16);
    assert.equal(bucketStart(thu, "month").getDate(), 1);
    const sun = new Date(2026, 10, 22, 9);    // Sunday belongs to the week of Monday 16th
    assert.equal(bucketStart(sun, "week").getDate(), 16);
  });

  test("daily buckets include empty days, which have no flagged share (a gap, not 0%)", () => {
    const b = bucketize([rec(at(2026, 11, 1), 10, 2), rec(at(2026, 11, 1, 18), 10, 0), rec(at(2026, 11, 4), 5, 5)], "day");
    assert.deepEqual(b.map((x) => x.analyses), [2, 0, 0, 1]);
    assert.deepEqual(b.map((x) => x.flaggedPercent), [10, null, null, 100]);
    assert.deepEqual(b.map((x) => x.windows), [20, 0, 0, 5]);
  });

  test("computeAnalytics picks weekly buckets for a two-month span", () => {
    const a = computeAnalytics(data([rec(at(2026, 9, 1), 10, 1), rec(at(2026, 10, 30), 10, 3)]));
    assert.equal(a.granularity, "week");
    assert.equal(a.buckets.reduce((s, b) => s + b.analyses, 0), 2);
    assert.ok(a.buckets.length >= 9 && a.buckets.length <= 10, `got ${a.buckets.length} weeks`);
  });
});

describe("breakdowns and notices", () => {
  test("type breakdown (only video is saved today; other stored types still counted)", () => {
    const a = computeAnalytics(data([rec(at(2026, 11, 1), 10, 1), rec(at(2026, 11, 2), 10, 3), rec(at(2026, 11, 2), 4, 2, { analysis_type: "imu" })]));
    assert.deepEqual(a.byType.map((t) => [t.type, t.label, t.analyses, t.flaggedPercent]), [
      ["video", "Video analysis", 2, 20], ["imu", "IMU analysis", 1, 50],
    ]);
  });

  test("reaching the retention limit is flagged and stated in the summary", () => {
    const records = Array.from({ length: 3 }, (_, i) => rec(at(2026, 11, 1 + i), 4, 1));
    assert.equal(computeAnalytics(data(records, 4)).atRetentionLimit, false);
    const a = computeAnalytics(data(records, 3));
    assert.equal(a.atRetentionLimit, true);
  });

  test("different model/threshold settings are listed so shares aren't compared blindly", () => {
    const a = computeAnalytics(data([rec(at(2026, 11, 1), 4, 1), rec(at(2026, 11, 2), 4, 1, { threshold: 0.5 })]));
    assert.equal(a.scoringVersions.length, 2);
    assert.equal(computeAnalytics(data([rec(at(2026, 11, 1), 4, 1)])).scoringVersions.length, 1);
  });

  test("plain-language summary and trend", () => {
    const a = computeAnalytics(data([
      rec(at(2026, 11, 1), 10, 0), rec(at(2026, 11, 2), 10, 0),
      rec(at(2026, 11, 3), 10, 5), rec(at(2026, 11, 4), 10, 5),
    ]));
    const s = describeAnalytics(a, "en-GB");
    assert.match(s, /^4 saved analyses between 1 Nov 2026 and 4 Nov 2026\./);
    assert.match(s, /10 windows of 40 scored windows \(25%\) were above the threshold, in 2 analyses\./);
    assert.equal(describeTrend(a), "The flagged share was higher in your more recent days (50% vs 0%).");
    // Too few periods: no trend claim.
    assert.equal(describeTrend(computeAnalytics(data([rec(at(2026, 11, 1), 10, 0), rec(at(2026, 11, 3), 10, 5)]))), null);
  });

  test("summary never claims fatigue, risk or safety", () => {
    const a = computeAnalytics(data([rec(at(2026, 11, 1), 10, 9), rec(at(2026, 11, 2), 10, 9), rec(at(2026, 11, 3), 10, 0), rec(at(2026, 11, 4), 10, 0)]));
    assert.doesNotMatch(describeAnalytics(a), /fatigue|risk|safe|injur|workload|tired/i);
  });
});

describe("loadAnalytics client", () => {
  test("GETs /api/analytics with the session cookie only: no IDs, no body", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ records: [], retention_limit: 100 }), { status: 200 });
    };
    const d = await loadAnalytics({ fetch });
    assert.deepEqual(d, { records: [], retention_limit: 100 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/analytics");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers, undefined, "no user, browser or tracking headers");
  });

  test("server errors throw AnalyticsError with the server's message and status", async () => {
    const fetch = async () => new Response(JSON.stringify({ detail: "Please log in to use Motion Atlas." }), { status: 401 });
    await assert.rejects(loadAnalytics({ fetch }), (e) => e instanceof AnalyticsError && e.status === 401 && /log in/.test(e.message));
  });

  test("non-JSON error pages and unexpected shapes throw readable errors", async () => {
    await assert.rejects(loadAnalytics({ fetch: async () => new Response("<html>", { status: 502 }) }), /HTTP 502/);
    await assert.rejects(loadAnalytics({ fetch: async () => new Response("{}", { status: 200 }) }), /expected format/);
  });
});
