// Shared test helpers: a real local D1 database (Miniflare, via wrangler's getPlatformProxy) with
// the repository's migrations applied, and a way to call the Worker's fetch handler directly.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";

export const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
export const MIGRATIONS_DIR = join(APP_DIR, "migrations");

/** Apply every migrations/NNNN_*.sql file in order (each file in one batch, like wrangler does). */
export async function applyMigrations(db) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = (await readFile(join(MIGRATIONS_DIR, f), "utf8")).replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  return files;
}

/** In-memory local D1 bound as DB, configured from wrangler.jsonc, with migrations applied. */
export async function localD1() {
  const proxy = await getPlatformProxy({ configPath: join(APP_DIR, "wrangler.jsonc"), persist: false });
  await applyMigrations(proxy.env.DB);
  return proxy;
}

/** Test-only Better Auth secret (32+ characters). */
export const TEST_AUTH_SECRET = "test-only-better-auth-secret-0123456789abcdef";

/**
 * Sign up a fresh user through the Worker's own Better Auth routes and return the session cookie
 * ("name=value; ..."), as the browser would send it. History is scoped to that user.
 */
export async function signUp(worker, env, { email = `${crypto.randomUUID()}@example.test`, password = "correct-horse-battery-staple", name = "Test user" } = {}) {
  const res = await worker.fetch(new Request("http://app.test/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://app.test" },
    body: JSON.stringify({ email, password, name }),
  }), env);
  if (res.status !== 200) throw new Error(`sign-up failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  return { cookie, userId: data.user.id, email };
}

/** Call the Worker like the browser would (`cookie`: the session cookie from signUp, if logged in). */
export function caller(worker, env) {
  return async (path, { method = "GET", cookie, body, headers = {} } = {}) => {
    const h = new Headers(headers);
    if (cookie) h.set("cookie", cookie);
    if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
    const res = await worker.fetch(new Request(`http://app.test${path}`, {
      method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text };
  };
}

/** A typical Render /predict/keypoints result (3 windows, one flagged). */
export function sampleResult() {
  return {
    model: "keypoint_autoencoder",
    windows_analyzed: 3,
    threshold: 0.42,
    windows_above_threshold: 1,
    percentage_above_threshold: 33.33,
    interpretation: "Scores describe movement deviations from the model's reference data; they are not a diagnosis or safety certification.",
    windows: [
      { window: 1, start_sample: 0, start_seconds: 0, end_seconds: 1.92, reconstruction_score: 0.31, above_threshold: false },
      { window: 2, start_sample: 48, start_seconds: 1.92, end_seconds: 3.84, reconstruction_score: 0.77, above_threshold: true },
      { window: 3, start_sample: 144, start_seconds: 5.76, end_seconds: 7.68, reconstruction_score: 0.12, above_threshold: false },
    ],
    posture_summary: {
      "median trunk lean (degrees)": 12.3,
      "median knee bend (degrees)": 20.1,
      "median arm elevation (degrees)": 35,
      "frames with shoulders/hips visible": 97.5,
      note: "Approximate 2D posture indicators from keypoints; not fatigue, danger, or validated worker strain.",
    },
  };
}

/** The save body the app sends for sampleResult(). */
export function sampleSave(overrides = {}) {
  const r = sampleResult();
  return {
    analysis_type: "video",
    duration_seconds: 8.2,
    model: r.model,
    threshold: r.threshold,
    interpretation: r.interpretation,
    posture_summary: r.posture_summary,
    windows: r.windows.map(({ start_sample: _drop, ...w }) => w),
    ...overrides,
  };
}
