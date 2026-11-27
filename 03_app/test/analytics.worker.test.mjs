// Worker /api/analytics against a real local D1: login required, only the shared History's records
// (decided by the Worker, never by a client-sent ID; rows saved under earlier per-user owners are left
// out), only summary fields (no per-window data, posture numbers, record IDs, video, keypoints or file
// names), and clear errors.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import worker from "../worker/index.ts";
import { MAX_RECORDS_PER_OWNER } from "../worker/history.ts";
import { computeAnalytics, loadAnalytics } from "../src/analytics.ts";
import { caller, clearSharedHistory, localD1, logIn, sampleSave, TEST_APP_PASSWORD } from "./helpers.mjs";

let proxy, env, call;
const newSession = () => logIn(worker, env);
const save = (cookie, overrides) => call("/api/history", { method: "POST", cookie, body: sampleSave(overrides) });

before(async () => {
  proxy = await localD1();
  env = { DB: proxy.env.DB, ASSETS: { fetch: async () => new Response("app") }, RENDER_API_URL: "http://127.0.0.1:9", APP_PASSWORD: TEST_APP_PASSWORD };
  call = caller(worker, env);
});
after(async () => { await proxy?.dispose(); });
beforeEach(async () => { if (env) await clearSharedHistory(env.DB); });

const SUMMARY_FIELDS = ["analysis_type", "created_at", "duration_seconds", "flagged_count", "flagged_percent", "model", "threshold", "window_count"];

describe("GET /api/analytics", () => {
  test("returns the shared History's summaries, oldest first, with the retention limit", async () => {
    const { cookie } = await newSession();
    assert.equal((await save(cookie)).status, 201);
    await new Promise((r) => setTimeout(r, 5));
    const allFlagged = sampleSave().windows.map((w) => ({ ...w, above_threshold: true }));
    assert.equal((await save(cookie, { windows: allFlagged, duration_seconds: null })).status, 201);

    const res = await call("/api/analytics", { cookie });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.retention_limit, MAX_RECORDS_PER_OWNER);
    assert.equal(res.data.records.length, 2);
    assert.deepEqual(res.data.records.map((r) => r.flagged_count), [1, 3], "oldest first");
    for (const r of res.data.records) assert.deepEqual(Object.keys(r).sort(), SUMMARY_FIELDS);
    assert.doesNotMatch(res.text, /windows_json|summary_json|posture|reconstruction_score|browser_id|"id"/);
    assert.equal(res.data.records[1].duration_seconds, null);

    const a = computeAnalytics(res.data);
    assert.equal(a.totals.windows, 6);
    assert.equal(a.totals.flaggedWindows, 4);
  });

  test("an empty shared History gives an empty list, not an error", async () => {
    const res = await call("/api/analytics", { cookie: (await newSession()).cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.records, []);
  });

  test("requires a valid session", async () => {
    for (const cookie of [undefined, "better-auth.session_token=forged", `__Host-motion-atlas-session=${"A".repeat(43)}`]) {
      const res = await call("/api/analytics", { cookie });
      assert.equal(res.status, 401);
      assert.equal(res.data.detail, "Please log in to use Motion Atlas.");
    }
  });

  test("every session sees the shared records; earlier per-user rows and client-sent IDs are ignored", async () => {
    const a = await newSession(), b = await newSession();
    assert.equal((await save(a.cookie)).status, 201);
    assert.equal((await call("/api/analytics", { cookie: b.cookie })).data.records.length, 1, "shared with every session");

    // A row saved before the shared password, under a per-user owner (a Better Auth user ID).
    const legacyOwner = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO analysis_history (id, browser_id, created_at, analysis_type, model, duration_seconds, window_count,
         flagged_count, flagged_percent, threshold, interpretation, summary_json, windows_json)
       VALUES (?1, ?2, ?3, 'video', 'keypoint_autoencoder', 8.2, 1, 1, 100, 0.42, '', '{}', '[[1,0,1.92,0.7,1]]')`,
    ).bind(crypto.randomUUID(), legacyOwner, Date.now()).run();

    const tries = [
      `/api/analytics?user_id=${legacyOwner}`,
      `/api/analytics?browser_id=${legacyOwner}&userId=${legacyOwner}`,
    ];
    for (const path of tries) {
      const res = await call(path, { cookie: b.cookie, headers: { "x-user-id": legacyOwner, "x-browser-id": legacyOwner } });
      assert.equal(res.data.records.length, 1, `${path}: only the shared record`);
      assert.equal((await call(path)).status, 401, `${path} without a session`);
    }
  });

  test("never returns more than the retention limit", async () => {
    const { cookie } = await newSession();
    for (let i = 0; i < MAX_RECORDS_PER_OWNER + 1; i++) assert.equal((await save(cookie)).status, 201);
    const res = await call("/api/analytics", { cookie });
    assert.equal(res.data.records.length, MAX_RECORDS_PER_OWNER);
    assert.equal(computeAnalytics(res.data).atRetentionLimit, true);
  });

  test("read-only: other methods are rejected and store nothing", async () => {
    const { cookie } = await newSession();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call("/api/analytics", { method, cookie, body: method === "DELETE" ? undefined : sampleSave() });
      assert.equal(res.status, 405, method);
    }
    assert.deepEqual((await call("/api/analytics", { cookie })).data.records, []);
    assert.equal((await call("/api/analytics/extra", { cookie })).status, 404);
  });

  test("a storage failure answers a JSON error", async () => {
    const { cookie } = await newSession();
    const broken = { ...env, DB: new Proxy(env.DB, {
      get: (t, k) => (k === "prepare" ? (sql) => (/analysis_history/.test(sql) ? { bind: () => ({ all: async () => { throw new Error("boom"); } }) } : t.prepare(sql)) : t[k]?.bind?.(t) ?? t[k]),
    }) };
    const failing = await caller(worker, broken)("/api/analytics", { cookie });
    assert.equal(failing.status, 500);
    assert.match(failing.data.detail, /Could not load your analytics/);
  });

  test("the app's own client against the Worker", async () => {
    const { cookie } = await newSession();
    await save(cookie);
    const fetch = (path, init) => worker.fetch(new Request(`http://app.test${path}`, { ...init, headers: { cookie } }), env);
    const d = await loadAnalytics({ fetch });
    assert.equal(d.records.length, 1);
    await assert.rejects(loadAnalytics({ fetch: (path, init) => worker.fetch(new Request(`http://app.test${path}`, init), env) }), /log in/);
  });
});
