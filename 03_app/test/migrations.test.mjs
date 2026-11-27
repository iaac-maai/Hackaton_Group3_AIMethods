// Migration behaviour: the schema the Worker relies on, its constraints, and that the real
// `wrangler d1 migrations apply --local` applies it once and then reports nothing to apply.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { APP_DIR, localD1 } from "./helpers.mjs";

describe("migration 0001 schema", () => {
  let proxy, db;
  before(async () => { proxy = await localD1(); db = proxy.env.DB; });
  after(async () => { await proxy?.dispose(); });

  test("creates analysis_history with only summary columns", async () => {
    const { results } = await db.prepare("SELECT name FROM pragma_table_info('analysis_history') ORDER BY cid").all();
    assert.deepEqual(results.map((r) => r.name), [
      "id", "browser_id", "created_at", "analysis_type", "model", "duration_seconds", "window_count",
      "flagged_count", "flagged_percent", "threshold", "interpretation", "summary_json", "windows_json",
    ]);
  });

  test("creates the browser/date and date indexes", async () => {
    const { results } = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analysis_history' AND name LIKE 'idx_%' ORDER BY name").all();
    assert.deepEqual(results.map((r) => r.name), ["idx_analysis_history_browser_created", "idx_analysis_history_created"]);
    const plan = await db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM analysis_history WHERE browser_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20")
      .bind("x").all();
    assert.match(JSON.stringify(plan.results), /idx_analysis_history_browser_created/);
  });

  const insert = (o = {}) => {
    const row = {
      id: crypto.randomUUID(), browser_id: crypto.randomUUID(), created_at: Date.now(), analysis_type: "video", model: "m",
      duration_seconds: 5, window_count: 2, flagged_count: 1, flagged_percent: 50, threshold: 0.4, interpretation: "",
      summary_json: "{}", windows_json: "[]", ...o,
    };
    const cols = Object.keys(row);
    return db.prepare(`INSERT INTO analysis_history (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
      .bind(...Object.values(row)).run();
  };

  test("accepts a valid row", async () => { await insert(); });

  for (const [name, bad] of [
    ["unknown analysis_type", { analysis_type: "audio" }],
    ["flagged_count above window_count", { flagged_count: 3 }],
    ["zero windows", { window_count: 0, flagged_count: 0 }],
    ["flagged_percent above 100", { flagged_percent: 101 }],
    ["non-positive duration", { duration_seconds: 0 }],
    ["invalid windows_json", { windows_json: "[1,2" }],
    ["invalid summary_json", { summary_json: "{oops" }],
    ["missing browser_id", { browser_id: null }],
  ]) {
    test(`rejects ${name}`, async () => { await assert.rejects(insert(bad)); });
  }
});

describe("migration 0003 schema (shared-password sessions)", () => {
  let proxy, db;
  before(async () => { proxy = await localD1(); db = proxy.env.DB; });
  after(async () => { await proxy?.dispose(); });

  test("creates app_session with only a token hash and times (no personal data)", async () => {
    const { results } = await db.prepare("SELECT name FROM pragma_table_info('app_session') ORDER BY cid").all();
    assert.deepEqual(results.map((r) => r.name), ["token_hash", "created_at", "expires_at"]);
    const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'app_session' AND name LIKE 'idx_%'").all();
    assert.deepEqual(idx.results.map((r) => r.name), ["idx_app_session_expires"]);
  });

  test("leaves the earlier tables in place (History and the old Better Auth tables are not dropped)", async () => {
    const { results } = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('analysis_history', 'user', 'session', 'account', 'verification') ORDER BY name").all();
    assert.deepEqual(results.map((r) => r.name), ["account", "analysis_history", "session", "user", "verification"]);
  });
});

describe("wrangler d1 migrations apply --local", () => {
  const wrangler = join(APP_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "motion-atlas-d1-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });
  const run = (...args) => spawnSync(process.execPath, [wrangler, "d1", ...args, "--local", "--persist-to", dir], {
    cwd: APP_DIR, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, timeout: 120_000,
  });

  test("applies every migration once, then has nothing left to apply", () => {
    const first = run("migrations", "apply", "DB");
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /0001_create_analysis_history\.sql/);
    assert.match(first.stdout, /0003_create_app_sessions\.sql/);
    const second = run("migrations", "apply", "DB");
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /No migrations to apply/i);
    const tables = run("execute", "DB", "--json", "--command",
      "SELECT name FROM sqlite_master WHERE name IN ('analysis_history', 'app_session', 'd1_migrations') ORDER BY name");
    assert.equal(tables.status, 0, tables.stderr + tables.stdout);
    assert.deepEqual(JSON.parse(tables.stdout)[0].results.map((r) => r.name), ["analysis_history", "app_session", "d1_migrations"]);
  });
});
