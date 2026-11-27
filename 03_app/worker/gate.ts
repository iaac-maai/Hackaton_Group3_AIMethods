/**
 * Shared team password gate.
 *
 * One password (the APP_PASSWORD Worker secret) is the only interactive sign-in. A correct password
 * creates a random session token: the browser keeps it in a Secure, HttpOnly, SameSite=Lax cookie,
 * and D1 keeps only its SHA-256 hash with an expiry (table app_session, migration 0003). Logging out
 * deletes the row, so a copied cookie stops working too. Nothing here identifies a person: the
 * password is shared, so every session has the same access (including one shared History).
 */
import type { D1Database } from "@cloudflare/workers-types";

/** `__Host-`: the browser only accepts it with Secure, Path=/ and no Domain, so subdomains can't set it. */
export const SESSION_COOKIE = "__Host-motion-atlas-session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const LOGIN_MAX_BYTES = 4 * 1024;
export const LOGIN_MESSAGE = "Please log in to use Motion Atlas.";
export const NOT_CONFIGURED_MESSAGE = "Login is not configured.";

/** Static files the login page itself needs; everything else is served only after login. */
export const PUBLIC_ASSETS = new Set(["/favicon.png", "/apple-touch-icon.png"]);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 random bytes, base64url without padding
const enc = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compares fixed-length digests of both values, so the time taken doesn't reveal how much matched. */
export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearedSessionCookie = () =>
  `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

/** Stores a new session (hash only) and removes expired ones. Returns the token for the cookie. */
export async function createSession(db: D1Database, now = Date.now()): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = toHex(await sha256(token));
  await db.batch([
    db.prepare("DELETE FROM app_session WHERE expires_at <= ?1").bind(now),
    db.prepare("INSERT INTO app_session (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)")
      .bind(hash, now, now + SESSION_TTL_SECONDS * 1000),
  ]);
  return token;
}

/** True only for a well-formed cookie whose hash is stored and not yet expired. */
export async function hasValidSession(db: D1Database, request: Request, now = Date.now()): Promise<boolean> {
  const token = readSessionToken(request);
  if (!token) return false;
  const row = await db
    .prepare("SELECT 1 AS ok FROM app_session WHERE token_hash = ?1 AND expires_at > ?2")
    .bind(toHex(await sha256(token)), now)
    .first();
  return row !== null;
}

export async function deleteSession(db: D1Database, request: Request): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;
  await db.prepare("DELETE FROM app_session WHERE token_hash = ?1").bind(toHex(await sha256(token))).run();
}

/**
 * Refuses state-changing requests sent from another site. Browsers send Origin on cross-site POSTs;
 * a request without Origin (curl, tests) is allowed, since it can't ride on a visitor's cookie.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

/** Server-rendered login page: no app code or data is sent before the password is accepted. */
export function loginPage(opts: { status?: number; error?: string } = {}): Response {
  const { status = 200, error } = opts;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Motion Atlas · Log in</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root { color-scheme: dark; --page: #060910; --card: #0c0f15; --ink: #fff; --ink-2: #c7c7cc; --muted: #9e9e9e;
    --accent: #f66f14; --err: #ff8a80; --err-bg: #2c1213; --line: rgb(255 255 255 / 0.12); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--page);
    color: var(--ink-2); font: 16px/1.5 Inter, "Segoe UI", system-ui, sans-serif; }
  main { width: min(400px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 32px 28px; }
  h1 { margin: 0; color: var(--ink); font: 800 1.9rem/1.2 Mulish, "Segoe UI", system-ui, sans-serif; letter-spacing: -0.01em; }
  .tagline { margin: 4px 0 24px; color: var(--muted); }
  form { display: flex; flex-direction: column; gap: 14px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 0.9rem; font-weight: 500; }
  input { width: 100%; padding: 11px 14px; font: inherit; color: var(--ink); background: #101319; border: 1px solid var(--line); border-radius: 10px; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { padding: 12px 16px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 999px; cursor: pointer; }
  button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .error { margin: 0; color: var(--err); background: var(--err-bg); border-radius: 10px; padding: 8px 12px; font-size: 0.9rem; }
  .note { margin: 18px 0 0; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>Motion Atlas</h1>
  <p class="tagline">Movement deviation analysis</p>
  <form method="post" action="/api/login">
    <input type="text" name="username" value="Motion Atlas team" autocomplete="username" hidden>
    <label>Team password
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    ${error ? `<p class="error" role="alert">${error}</p>` : ""}
    <button type="submit">Log in</button>
  </form>
  <p class="note">One password for the whole team. Everyone who logs in shares the same History.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    },
  });
}
