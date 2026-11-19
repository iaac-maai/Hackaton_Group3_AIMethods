// Worker /api/analytics against a real local D1: login required, only the signed-in user's own
// records (decided by the session, never by a client-sent ID), only summary fields (no per-window
// data, posture numbers, record IDs, video, keypoints or file names), and clear errors.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import worker from "../worker/index.ts";
import { MAX_RECORDS_PER_USER } from "../worker/history.ts";
import { computeAnalytics, loadAnalytics } from "../src/analytics.ts";
import { caller, localD1, sampleSave, signUp, TEST_AUTH_SECRET } from "./helpers.mjs";

let proxy, env, call;
const newUser = () => signUp(worker, env);
const save = (cookie, overrides) => call("/api/history", { method: "POST", cookie, body: sampleSave(overrides) });

before(async () => {
  proxy = await localD1();
  env = { DB: proxy.env.DB, ASSETS: { fetch: async () => new Response("app") }, RENDER_API_URL: "http://127.0.0.1:9", BETTER_AUTH_SECRET: TEST_AUTH_SECRET };
  call = caller(worker, env);
});
after(async () => { await proxy?.dispose(); });

const SUMMARY_FIELDS = ["analysis_type", "created_at", "duration_seconds", "flagged_count", "flagged_percent", "model", "threshold", "window_count"];

describe("GET /api/analytics", () => {
  test("returns the user's saved summaries, oldest first, with the retention limit", async () => {
    const { cookie } = await newUser();
    assert.equal((await save(cookie)).status, 201);
    await new Promise((r) => setTimeout(r, 5));
    const allFlagged = sampleSave().windows.map((w) => ({ ...w, above_threshold: true }));
    assert.equal((await save(cookie, { windows: allFlagged, duration_seconds: null })).status, 201);

    const res = await call("/api/analytics", { cookie });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.retention_limit, MAX_RECORDS_PER_USER);
    assert.equal(res.data.records.length, 2);
    assert.deepEqual(res.data.records.map((r) => r.flagged_count), [1, 3], "oldest first");
    for (const r of res.data.records) assert.deepEqual(Object.keys(r).sort(), SUMMARY_FIELDS);
    assert.doesNotMatch(res.text, /windows_json|summary_json|posture|reconstruction_score|browser_id|"id"/);
    assert.equal(res.data.records[1].duration_seconds, null);

    const a = computeAnalytics(res.data);
    assert.equal(a.totals.windows, 6);
    assert.equal(a.totals.flaggedWindows, 4);
  });

  test("a new user gets an empty list, not an error", async () => {
    const res = await call("/api/analytics", { cookie: (await newUser()).cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.records, []);
  });

  test("requires a valid session", async () => {
    for (const cookie of [undefined, "better-auth.session_token=forged"]) {
      const res = await call("/api/analytics", { cookie });
      assert.equal(res.status, 401);
      assert.equal(res.data.detail, "Please log in to use Motion Atlas.");
    }
  });

  test("users only see their own records; client-sent IDs are ignored", async () => {
    const owner = await newUser(), other = await newUser();
    assert.equal((await save(owner.cookie)).status, 201);
    assert.deepEqual((await call("/api/analytics", { cookie: other.cookie })).data.records, []);

    const tries = [
      `/api/analytics?user_id=${owner.userId}`,
      `/api/analytics?browser_id=${owner.userId}&userId=${owner.userId}`,
    ];
    for (const path of tries) {
      assert.deepEqual((await call(path, { cookie: other.cookie, headers: { "x-user-id": owner.userId, "x-browser-id": owner.userId } })).data.records, [], path);
      assert.equal((await call(path)).status, 401, `${path} without a session`);
    }
    assert.equal((await call("/api/analytics", { cookie: owner.cookie })).data.records.length, 1);
  });

  test("never returns more than the retention limit", async () => {
    const { cookie } = await newUser();
    for (let i = 0; i < MAX_RECORDS_PER_USER + 1; i++) assert.equal((await save(cookie)).status, 201);
    const res = await call("/api/analytics", { cookie });
    assert.equal(res.data.records.length, MAX_RECORDS_PER_USER);
    assert.equal(computeAnalytics(res.data).atRetentionLimit, true);
  });

  test("read-only: other methods are rejected and store nothing", async () => {
    const { cookie } = await newUser();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call("/api/analytics", { method, cookie, body: method === "DELETE" ? undefined : sampleSave() });
      assert.equal(res.status, 405, method);
    }
    assert.deepEqual((await call("/api/analytics", { cookie })).data.records, []);
    assert.equal((await call("/api/analytics/extra", { cookie })).status, 404);
  });

  test("a storage failure answers a JSON error", async () => {
    const { cookie } = await newUser();
    const broken = { ...env, DB: new Proxy(env.DB, {
      get: (t, k) => (k === "prepare" ? (sql) => (/analysis_history/.test(sql) ? { bind: () => ({ all: async () => { throw new Error("boom"); } }) } : t.prepare(sql)) : t[k]?.bind?.(t) ?? t[k]),
    }) };
    const failing = await caller(worker, broken)("/api/analytics", { cookie });
    assert.equal(failing.status, 500);
    assert.match(failing.data.detail, /Could not load your analytics/);
  });

  test("the app's own client against the Worker", async () => {
    const { cookie } = await newUser();
    await save(cookie);
    const fetch = (path, init) => worker.fetch(new Request(`http://app.test${path}`, { ...init, headers: { cookie } }), env);
    const d = await loadAnalytics({ fetch });
    assert.equal(d.records.length, 1);
    await assert.rejects(loadAnalytics({ fetch: (path, init) => worker.fetch(new Request(`http://app.test${path}`, init), env) }), /log in/);
  });
});
