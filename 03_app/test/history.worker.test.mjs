// Worker history routes against a real local D1: save/list/load/delete, validation, the shared
// History (one owner for everyone with the team password), that rows saved under earlier per-user
// owners stay hidden and untouched, payload limits, and that analysis keeps working when history
// storage is unavailable. Sessions come from the Worker's own /api/login (all migrations applied).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import worker from "../worker/index.ts";
import { LIST_MAX, MAX_RECORDS_PER_OWNER, MAX_WINDOWS } from "../worker/history.ts";
import { deleteHistory, listHistory, loadHistory, persistAnalysis } from "../src/history.ts";
import { caller, clearSharedHistory, localD1, logIn, sampleResult, sampleSave, SHARED_OWNER, TEST_APP_PASSWORD } from "./helpers.mjs";

let proxy, env, call, render, renderUrl;
const newSession = () => logIn(worker, env);

/** A row saved before the shared password, under a per-user owner (a Better Auth user ID). */
async function insertLegacyRow(db, owner = crypto.randomUUID()) {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO analysis_history (id, browser_id, created_at, analysis_type, model, duration_seconds, window_count,
       flagged_count, flagged_percent, threshold, interpretation, summary_json, windows_json)
     VALUES (?1, ?2, ?3, 'video', 'keypoint_autoencoder', 8.2, 1, 1, 100, 0.42, '', '{}', '[[1,0,1.92,0.7,1]]')`,
  ).bind(id, owner, Date.now()).run();
  return { id, owner };
}

before(async () => {
  proxy = await localD1();
  // Stand-in for the Render model API, to check analysis routing is independent of history.
  render = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sampleResult()));
    });
  });
  await new Promise((r) => render.listen(0, "127.0.0.1", r));
  renderUrl = `http://127.0.0.1:${render.address().port}`;
  env = { DB: proxy.env.DB, ASSETS: { fetch: async () => new Response("app") }, RENDER_API_URL: renderUrl, APP_PASSWORD: TEST_APP_PASSWORD };
  call = caller(worker, env);
});
after(async () => { await proxy?.dispose(); render?.close(); });
// The History is shared by every session, so each test starts from an empty shared History.
beforeEach(async () => { if (env) await clearSharedHistory(env.DB); });

describe("save, list, load, delete", () => {
  test("round trip keeps the summary and per-window data", async () => {
    const { cookie } = await newSession();
    const saved = await call("/api/history", { method: "POST", cookie, body: sampleSave() });
    assert.equal(saved.status, 201, saved.text);
    assert.match(saved.data.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.data.label, "Video analysis");
    assert.equal(saved.data.analysis_type, "video");
    assert.equal(saved.data.duration_seconds, 8.2);
    assert.equal(saved.data.window_count, 3);
    assert.equal(saved.data.flagged_count, 1);
    assert.equal(saved.data.flagged_percent, 33.33);
    assert.ok(!Number.isNaN(Date.parse(saved.data.created_at)));

    const list = await call("/api/history", { cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.items, [saved.data]);
    assert.equal(list.data.items[0].windows, undefined, "the list never carries per-window data");

    const loaded = await call(`/api/history/${saved.data.id}`, { cookie });
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.data.windows, sampleSave().windows);
    assert.deepEqual(loaded.data.posture_summary, sampleSave().posture_summary);
    assert.equal(loaded.data.threshold, 0.42);
    assert.equal(loaded.data.model, "keypoint_autoencoder");

    const del = await call(`/api/history/${saved.data.id}`, { method: "DELETE", cookie });
    assert.equal(del.status, 200);
    assert.equal((await call(`/api/history/${saved.data.id}`, { cookie })).status, 404);
    assert.equal((await call(`/api/history/${saved.data.id}`, { method: "DELETE", cookie })).status, 404);
    assert.deepEqual((await call("/api/history", { cookie })).data.items, []);
  });

  test("flag counts are computed from the windows, not trusted from the client", async () => {
    const { cookie } = await newSession();
    const windows = sampleSave().windows.map((w) => ({ ...w, above_threshold: true }));
    const saved = await call("/api/history", { method: "POST", cookie, body: sampleSave({ windows }) });
    assert.equal(saved.data.flagged_count, 3);
    assert.equal(saved.data.flagged_percent, 100);
  });

  test("duration is optional", async () => {
    const saved = await call("/api/history", { method: "POST", cookie: (await newSession()).cookie, body: sampleSave({ duration_seconds: null }) });
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.data.duration_seconds, null);
  });

  test("list is newest first and limited", async () => {
    const { cookie } = await newSession();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await call("/api/history", { method: "POST", cookie, body: sampleSave() })).data.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await call("/api/history", { cookie });
    assert.deepEqual(all.data.items.map((i) => i.id), ids.reverse());
    const one = await call("/api/history?limit=1", { cookie });
    assert.equal(one.data.items.length, 1);
    for (const bad of ["0", String(LIST_MAX + 1), "abc", "1.5", "-1"]) {
      assert.equal((await call(`/api/history?limit=${bad}`, { cookie })).status, 400, `limit=${bad}`);
    }
  });

  test(`keeps only the newest ${MAX_RECORDS_PER_OWNER} records in the shared History`, async () => {
    const { cookie } = await newSession();
    const legacy = await insertLegacyRow(env.DB);
    for (let i = 0; i < MAX_RECORDS_PER_OWNER + 2; i++) {
      assert.equal((await call("/api/history", { method: "POST", cookie, body: sampleSave() })).status, 201);
    }
    // The owner column (named browser_id before logins existed) holds the shared owner for new rows.
    const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM analysis_history WHERE browser_id = ?1").bind(SHARED_OWNER).first();
    assert.equal(count, MAX_RECORDS_PER_OWNER);
    const kept = await env.DB.prepare("SELECT id FROM analysis_history WHERE id = ?1").bind(legacy.id).first();
    assert.ok(kept, "pruning the shared History never deletes rows saved under earlier per-user owners");
  });
});

describe("shared History", () => {
  test("everyone who logs in with the team password sees, opens and deletes the same records", async () => {
    const a = await newSession(), b = await newSession();
    assert.notEqual(a.cookie, b.cookie, "each login gets its own session");
    const { data: item } = await call("/api/history", { method: "POST", cookie: a.cookie, body: sampleSave() });
    assert.deepEqual((await call("/api/history", { cookie: b.cookie })).data.items.map((i) => i.id), [item.id]);
    assert.equal((await call(`/api/history/${item.id}`, { cookie: b.cookie })).status, 200);
    assert.equal((await call(`/api/history/${item.id}`, { method: "DELETE", cookie: b.cookie })).status, 200);
    assert.deepEqual((await call("/api/history", { cookie: a.cookie })).data.items, []);
  });

  test("rows saved earlier under per-user owners stay in D1 but are never listed, opened or deleted", async () => {
    const { cookie } = await newSession();
    const legacy = await insertLegacyRow(env.DB);
    assert.deepEqual((await call("/api/history", { cookie })).data.items, []);
    assert.equal((await call(`/api/history/${legacy.id}`, { cookie })).status, 404);
    assert.equal((await call(`/api/history/${legacy.id}`, { method: "DELETE", cookie })).status, 404);
    const row = await env.DB.prepare("SELECT browser_id FROM analysis_history WHERE id = ?1").bind(legacy.id).first();
    assert.equal(row.browser_id, legacy.owner, "the legacy row is untouched");
  });

  test("an ID sent by the client never selects whose history is used", async () => {
    const { cookie } = await newSession();
    const legacy = await insertLegacyRow(env.DB);
    const forged = { "x-browser-id": legacy.owner, "x-user-id": legacy.owner };
    assert.deepEqual((await call(`/api/history?browser_id=${legacy.owner}`, { cookie, headers: forged })).data.items, []);
    assert.equal((await call(`/api/history/${legacy.id}`, { cookie, headers: forged })).status, 404);
    // An owner field in the body is rejected, not used.
    for (const extra of [{ user_id: legacy.owner }, { browser_id: legacy.owner }]) {
      const res = await call("/api/history", { method: "POST", cookie, body: sampleSave(extra) });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
  });

  test("every history route requires a valid session", async () => {
    const id = crypto.randomUUID();
    const forgedToken = "A".repeat(43);
    for (const cookie of [undefined, "", `__Host-motion-atlas-session=${forgedToken}`, "__Host-motion-atlas-session=' OR 1=1 --",
      "better-auth.session_token=forged.value"]) {
      for (const [path, method, body] of [
        ["/api/history", "GET"], ["/api/history", "POST", sampleSave()], [`/api/history/${id}`, "GET"], [`/api/history/${id}`, "DELETE"],
      ]) {
        const res = await call(path, { method, cookie, body, headers: { "x-browser-id": SHARED_OWNER } });
        assert.equal(res.status, 401, `${method} ${path} with ${JSON.stringify(cookie)}`);
        assert.match(res.data.detail, /log in/);
      }
    }
  });

  test("after logging out, the old session cookie no longer works", async () => {
    const { cookie } = await newSession();
    assert.equal((await call("/api/history", { cookie })).status, 200);
    const out = await call("/api/logout", { method: "POST", cookie, headers: { origin: "http://app.test" } });
    assert.equal(out.status, 303);
    assert.equal((await call("/api/history", { cookie })).status, 401);
  });
});

describe("request validation", () => {
  let cookie;
  before(async () => { ({ cookie } = await newSession()); });
  const post = (body, headers) => call("/api/history", { method: "POST", cookie, body, headers });

  test("rejects raw data and file names (unknown fields), storing nothing", async () => {
    for (const extra of [{ frames: [[[1, 2, 0.9]]] }, { keypoints: [] }, { imu_samples: [] }, { file_name: "site-a.mp4" }, { label: "x" }]) {
      const res = await post(sampleSave(extra));
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(res.data.detail, /Unexpected field/);
    }
    const windows = sampleSave().windows.map((w, i) => (i ? w : { ...w, keypoints: [[1, 2, 3]] }));
    assert.equal((await post(sampleSave({ windows }))).status, 400);
    assert.deepEqual((await call("/api/history", { cookie })).data.items, []);
  });

  test("rejects invalid values", async () => {
    const w = sampleSave().windows[0];
    for (const bad of [
      { analysis_type: "imu" }, { analysis_type: "../x" }, { duration_seconds: -1 }, { duration_seconds: "8" },
      { model: "" }, { threshold: "0.4" }, { threshold: -1 }, { interpretation: "x".repeat(501) },
      { windows: [] }, { windows: "[]" }, { windows: [{ ...w, end_seconds: w.start_seconds }] },
      { windows: [{ ...w, reconstruction_score: "NaN" }] }, { windows: [{ ...w, above_threshold: 1 }] },
      { windows: [{ ...w, window: 1.5 }] }, { posture_summary: [] }, { posture_summary: { a: { nested: 1 } } },
      { windows: Array.from({ length: MAX_WINDOWS + 1 }, (_, i) => ({ ...w, window: i })) },
    ]) {
      const res = await post(sampleSave(bad));
      assert.equal(res.status, 400, `${JSON.stringify(bad).slice(0, 80)} -> ${res.text}`);
    }
    assert.equal((await post(sampleSave({ model: undefined }))).status, 400);
  });

  test("rejects malformed and oversized bodies", async () => {
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post(JSON.stringify(sampleSave()), { "content-type": "text/plain" })).status, 415);
    const huge = JSON.stringify(sampleSave({ interpretation: "x".repeat(300 * 1024) }));
    assert.equal((await post(huge)).status, 413);
  });

  test("rejects bad IDs, routes and methods", async () => {
    assert.equal((await call("/api/history/123", { cookie })).status, 400);
    assert.equal((await call("/api/history/%27%20OR%201%3D1", { cookie })).status, 400);
    assert.equal((await call(`/api/history/${crypto.randomUUID()}/x`, { cookie })).status, 404);
    assert.equal((await call(`/api/history/${crypto.randomUUID()}`, { cookie })).status, 404);
    assert.equal((await call("/api/history", { method: "DELETE", cookie })).status, 405);
    assert.equal((await call(`/api/history/${crypto.randomUUID()}`, { method: "POST", cookie, body: {} })).status, 405);
  });
});

describe("history failures don't affect analysis", () => {
  // Node's fetch needs `duplex` to stream a request body; workerd doesn't. Test-only shim.
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = (input, init) => realFetch(input, init?.body instanceof ReadableStream ? { ...init, duplex: "half" } : init);
  });
  after(() => { globalThis.fetch = realFetch; });

  const frames = '{"frames":[[[0,0,0]]]}';
  const analyze = (e, cookie) => worker.fetch(new Request("http://app.test/api/analyze/keypoints", {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(frames.length), ...(cookie ? { cookie } : {}) }, body: frames,
  }), e);

  test("analysis needs a login, like history", async () => {
    const a = await analyze(env);
    assert.equal(a.status, 401);
    assert.match((await a.json()).detail, /log in/);
  });

  // Sessions use the same D1 database, so "history storage failing" means its table failing while app_session still works.
  test("failing history storage: history answers a JSON 500, analysis still works", async () => {
    const { cookie } = await newSession();
    const e = { ...env, DB: historyBroken(env.DB) };
    const c = caller(worker, e);
    for (const [path, method, body] of [["/api/history", "GET"], ["/api/history", "POST", sampleSave()], [`/api/history/${crypto.randomUUID()}`, "GET"]]) {
      const res = await c(path, { method, cookie, body });
      assert.equal(res.status, 500, `${method} ${path}`);
      assert.match(res.data.detail, /analysis itself is not affected/);
    }
    const a = await analyze(e, cookie);
    assert.equal(a.status, 200);
    assert.equal((await a.json()).windows_analyzed, 3);
  });

  test("no DB binding: protected routes answer a JSON error instead of crashing", async () => {
    const { cookie } = await newSession();
    const e = { ...env, DB: undefined };
    const res = await caller(worker, e)("/api/history", { cookie });
    assert.ok(res.status >= 500, `HTTP ${res.status}`);
    assert.equal(typeof res.data?.detail, "string");
    const a = await analyze(e, cookie);
    assert.ok(a.status >= 500, `HTTP ${a.status}`);
  });

  test("no team password set: protected routes say login isn't configured", async () => {
    const { cookie } = await newSession();
    for (const e of [{ ...env, APP_PASSWORD: "" }, { ...env, APP_PASSWORD: undefined }]) {
      const h = await caller(worker, e)("/api/history", { cookie });
      assert.equal(h.status, 503);
      assert.match(h.data.detail, /Login is not configured/);
      const a = await analyze(e, cookie);
      assert.equal(a.status, 503);
      assert.match((await a.json()).detail, /Login is not configured/);
    }
  });
});

describe("app history client against the Worker", () => {
  // Like the browser: the session cookie is attached to the app's same-origin requests.
  const viaWorker = (cookie, e = env) => ({
    fetch: (path, init) => {
      assert.equal(init.credentials, "same-origin", "the app sends the session cookie with history requests");
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie);
      return worker.fetch(new Request(new URL(path, "http://app.test"), { ...init, headers }), e);
    },
  });

  test("persist, list, restore and delete with the app's own functions", async () => {
    const opts = viaWorker((await newSession()).cookie);
    const result = sampleResult();
    const outcome = await persistAnalysis(result, 8.2, 1.92, opts);
    assert.equal(outcome.saved, true);
    const items = await listHistory(opts);
    assert.deepEqual(items.map((i) => i.id), [outcome.item.id]);

    const restored = await loadHistory(outcome.item.id, opts);
    assert.equal(restored.item.duration_seconds, 8.2);
    assert.equal(restored.result.windows_analyzed, result.windows_analyzed);
    assert.equal(restored.result.windows_above_threshold, result.windows_above_threshold);
    assert.equal(restored.result.threshold, result.threshold);
    assert.deepEqual(restored.result.posture_summary, result.posture_summary);
    assert.deepEqual(
      restored.result.windows.map(({ start_sample: _s, ...w }) => w),
      result.windows.map(({ start_sample: _s, ...w }) => w),
      "timeline and jump-to-moment data are restored exactly");

    await deleteHistory(outcome.item.id, opts);
    assert.deepEqual(await listHistory(opts), []);
    await assert.rejects(loadHistory(outcome.item.id, opts), (e) => e.status === 404);
  });

  test("a save that fails on the Worker is reported, not thrown", async () => {
    const opts = viaWorker((await newSession()).cookie, { ...env, DB: historyBroken(env.DB) });
    const outcome = await persistAnalysis(sampleResult(), 8.2, 1.92, opts);
    assert.equal(outcome.saved, false);
    assert.match(outcome.message, /analysis itself is not affected/);
  });

  test("logged out: a save is reported as not saved, with the login message", async () => {
    const opts = { fetch: (path, init) => worker.fetch(new Request(new URL(path, "http://app.test"), init), env) };
    const outcome = await persistAnalysis(sampleResult(), 8.2, 1.92, opts);
    assert.deepEqual(outcome, { saved: false, message: "Please log in to use Motion Atlas." });
  });
});

/** The real local D1, except that anything touching the analysis_history table fails (app_session keeps working). */
function historyBroken(db) {
  const check = (sql) => { if (/analysis_history/i.test(sql)) throw new Error("D1_ERROR: analysis_history unavailable"); };
  return {
    prepare(sql) { check(sql); return db.prepare(sql); },
    batch(stmts) { return db.batch(stmts); },
    exec(sql) { check(sql); return db.exec(sql); },
  };
}
