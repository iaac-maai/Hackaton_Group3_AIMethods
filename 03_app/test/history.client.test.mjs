// App-side history helpers: what is sent when saving, that requests carry the login session (and no
// browser-generated ID), and that a failed save is reported as a value (so the analysis that was just
// shown stays on screen). Ownership is decided by the Worker after its login check (one shared History).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deleteHistory, listHistory, loadHistory, persistAnalysis, toSaveRequest } from "../src/history.ts";
import * as history from "../src/history.ts";
import { sampleResult } from "./helpers.mjs";

/** A fetch that records every request and answers with `answer(path, init)`. */
function recorder(answer = () => new Response(JSON.stringify({ items: [] }), { status: 200 })) {
  const seen = [];
  return { seen, fetch: async (path, init) => { seen.push({ path, init }); return answer(path, init); } };
}

describe("identity comes from the login session", () => {
  test("every history request sends the session cookie (same-origin) and no browser or user ID", async () => {
    const id = crypto.randomUUID();
    const rec = recorder((path, init) => new Response(JSON.stringify(
      init.method === "POST" ? { id } : path.includes(id) ? { id, created_at: "", analysis_type: "video", label: "", duration_seconds: null,
        window_count: 0, flagged_count: 0, flagged_percent: 0, model: "m", threshold: 0.4, interpretation: "", posture_summary: {}, windows: [] } : { items: [] },
    ), { status: init.method === "POST" ? 201 : 200 }));
    await listHistory({ fetch: rec.fetch });
    await loadHistory(id, { fetch: rec.fetch });
    await deleteHistory(id, { fetch: rec.fetch });
    await persistAnalysis(sampleResult(), 8.2, 1.92, { fetch: rec.fetch });
    assert.deepEqual(rec.seen.map((r) => r.init.method), ["GET", "GET", "DELETE", "POST"]);
    for (const { path, init } of rec.seen) {
      assert.equal(init.credentials, "same-origin", path);
      const h = new Headers(init.headers);
      assert.equal(h.get("x-browser-id"), null, path);
      assert.equal(h.get("x-user-id"), null, path);
      assert.doesNotMatch(path, /browser|user/i);
    }
    assert.doesNotMatch(rec.seen[3].init.body, /"(browser_id|user_id|owner)"\s*:/);
  });

  test("the browser-ID helpers are gone, and nothing is written to localStorage", async () => {
    assert.equal(history.getBrowserId, undefined);
    assert.equal(history.BROWSER_ID_KEY, undefined);
    const writes = [];
    const had = "localStorage" in globalThis;
    const prev = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem: (k) => writes.push(k), removeItem: () => {} };
    try {
      await persistAnalysis(sampleResult(), 8.2, 1.92, recorder(() => new Response(JSON.stringify({ id: "x" }), { status: 201 })));
      await listHistory(recorder());
    } finally {
      if (had) globalThis.localStorage = prev; else delete globalThis.localStorage;
    }
    assert.deepEqual(writes, []);
  });

  test("a logged-out save (401) is reported with the server's message, not thrown", async () => {
    const fetch = async () => new Response(JSON.stringify({ detail: "Please log in to use Motion Atlas." }), { status: 401 });
    assert.deepEqual(await persistAnalysis(sampleResult(), 8.2, 1.92, { fetch }), { saved: false, message: "Please log in to use Motion Atlas." });
    await assert.rejects(listHistory({ fetch }), (e) => e.name === "HistoryError" && e.status === 401);
  });
});

describe("save request", () => {
  test("contains only the summary and per-window score/time/flag", () => {
    const body = toSaveRequest(sampleResult(), 8.2004, 1.92);
    assert.deepEqual(Object.keys(body).sort(),
      ["analysis_type", "duration_seconds", "interpretation", "model", "posture_summary", "threshold", "windows"]);
    assert.equal(body.analysis_type, "video");
    assert.equal(body.duration_seconds, 8.2);
    for (const w of body.windows) {
      assert.deepEqual(Object.keys(w).sort(), ["above_threshold", "end_seconds", "reconstruction_score", "start_seconds", "window"]);
    }
  });

  test("fills a missing end time from the window length (older Render API)", () => {
    const r = sampleResult();
    delete r.windows[1].end_seconds;
    assert.equal(toSaveRequest(r, 8, 1.92).windows[1].end_seconds, 3.84);
  });

  test("sends no duration when it is unknown", () => {
    assert.equal(toSaveRequest(sampleResult(), 0, 1.92).duration_seconds, null);
  });
});

describe("persistAnalysis", () => {
  test("posts JSON with the session cookie", async () => {
    let seen;
    const fetch = async (path, init) => {
      seen = { path, init };
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 201 });
    };
    const outcome = await persistAnalysis(sampleResult(), 8.2, 1.92, { fetch });
    assert.equal(outcome.saved, true);
    assert.equal(seen.path, "/api/history");
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.credentials, "same-origin");
    assert.equal(new Headers(seen.init.headers).get("content-type"), "application/json");
    // No raw-data keys. (The API's posture note itself mentions "keypoints" in prose, so match keys.)
    assert.doesNotMatch(seen.init.body, /"(start_sample|frames|keypoints|file_?name|name)"\s*:|\.mp4/i);
  });

  test("network failure resolves to { saved: false } and leaves the result untouched", async () => {
    const result = sampleResult();
    const before = structuredClone(result);
    const outcome = await persistAnalysis(result, 8.2, 1.92, { fetch: async () => { throw new TypeError("Failed to fetch"); } });
    assert.deepEqual(outcome, { saved: false, message: "Could not reach the history service." });
    assert.deepEqual(result, before);
  });

  test("server errors resolve to { saved: false } with the server's message", async () => {
    const fetch = async () => new Response(JSON.stringify({ detail: "History storage failed." }), { status: 500 });
    const outcome = await persistAnalysis(sampleResult(), 8.2, 1.92, { fetch });
    assert.deepEqual(outcome, { saved: false, message: "History storage failed." });
  });

  test("non-JSON error pages resolve to { saved: false }", async () => {
    const fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
    const outcome = await persistAnalysis(sampleResult(), 8.2, 1.92, { fetch });
    assert.equal(outcome.saved, false);
    assert.match(outcome.message, /HTTP 502/);
  });
});
