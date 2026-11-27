// The shared team password gate, against a real local D1 (all migrations applied): correct and wrong
// passwords, missing configuration, the session cookie and its D1 row, logout, expiry, and that every
// private API route and the app itself need a session while the health check and login stay public.
// The password used here is a test-only value; the real one is the APP_PASSWORD Worker secret.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import worker from "../worker/index.ts";
import { createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../worker/gate.ts";
import { caller, localD1, logIn, postLogin, sampleResult, sampleSave, TEST_APP_PASSWORD } from "./helpers.mjs";

let proxy, env, call, render, assetCalls;

before(async () => {
  proxy = await localD1();
  // Stand-in for the Render model API (health and scoring).
  render = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? { status: "ok" } : sampleResult()));
    });
  });
  await new Promise((r) => render.listen(0, "127.0.0.1", r));
  assetCalls = [];
  env = {
    DB: proxy.env.DB,
    ASSETS: { fetch: async (req) => { assetCalls.push(new URL(req.url).pathname); return new Response("app"); } },
    RENDER_API_URL: `http://127.0.0.1:${render.address().port}`,
    APP_PASSWORD: TEST_APP_PASSWORD,
  };
  call = caller(worker, env);
});
after(async () => { await proxy?.dispose(); render?.close(); });

const get = (path, { cookie, e = env, method = "GET", headers = {} } = {}) =>
  worker.fetch(new Request(`http://app.test${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...headers } }), e);
const tokenOf = (cookie) => cookie.split("=")[1];
const hashOf = async (token) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
const sessionRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM app_session").first()).n;

describe("logging in", () => {
  test("the correct password sets a Secure, HttpOnly, SameSite session cookie and redirects to the app", async () => {
    const res = await postLogin(worker, env, TEST_APP_PASSWORD);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const [setCookie, ...rest] = res.headers.getSetCookie();
    assert.equal(rest.length, 0);
    const [pair, ...attrs] = setCookie.split(";").map((s) => s.trim());
    const [name, token] = pair.split("=");
    assert.equal(name, SESSION_COOKIE);
    assert.match(name, /^__Host-/, "host-only cookie: no Domain, Path=/ and Secure are enforced by the browser");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
    assert.deepEqual(attrs.sort(), ["HttpOnly", `Max-Age=${SESSION_TTL_SECONDS}`, "Path=/", "SameSite=Lax", "Secure"].sort());
    assert.equal(SESSION_TTL_SECONDS, 12 * 60 * 60);
  });

  test("D1 stores only the token's hash with an expiry, never the token or the password", async () => {
    const before = Date.now();
    const { cookie } = await logIn(worker, env);
    const token = tokenOf(cookie);
    const row = await env.DB.prepare("SELECT * FROM app_session WHERE token_hash = ?1").bind(await hashOf(token)).first();
    assert.ok(row, "the hash is stored");
    assert.deepEqual(Object.keys(row).sort(), ["created_at", "expires_at", "token_hash"]);
    assert.ok(row.expires_at - row.created_at === SESSION_TTL_SECONDS * 1000);
    assert.ok(row.created_at >= before);
    const { results } = await env.DB.prepare("SELECT * FROM app_session").all();
    assert.doesNotMatch(JSON.stringify(results), new RegExp(`${token}|${TEST_APP_PASSWORD}`));
  });

  test("a wrong, empty or differently-cased password is refused: 401, login page with an error, no cookie", async () => {
    const rows = await sessionRows();
    for (const password of ["wrong", "", ` ${TEST_APP_PASSWORD}`, TEST_APP_PASSWORD.toUpperCase(), `${TEST_APP_PASSWORD}x`]) {
      const res = await postLogin(worker, env, password);
      assert.equal(res.status, 401, JSON.stringify(password));
      assert.deepEqual(res.headers.getSetCookie(), []);
      const html = await res.text();
      assert.match(html, /That password isn’t right/);
      assert.match(html, /<form method="post" action="\/api\/login">/);
      if (password) assert.ok(!html.includes(password), "the submitted password is never echoed back");
    }
    assert.equal(await sessionRows(), rows, "no session was created");
  });

  test("only a same-site form POST is accepted", async () => {
    assert.equal((await get("/api/login")).status, 405);
    const json = await worker.fetch(new Request("http://app.test/api/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: TEST_APP_PASSWORD }),
    }), env);
    assert.equal(json.status, 415);
    const crossSite = await postLogin(worker, env, TEST_APP_PASSWORD, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(crossSite.headers.getSetCookie(), []);
    const huge = await postLogin(worker, env, "x".repeat(5000));
    assert.equal(huge.status, 413);
  });
});

describe("missing configuration", () => {
  for (const [label, patch] of [["APP_PASSWORD empty", { APP_PASSWORD: "" }], ["APP_PASSWORD unset", { APP_PASSWORD: undefined }], ["no DB binding", { DB: undefined }]]) {
    test(`${label}: login, page and private APIs say login isn't configured; health still works`, async () => {
      const e = { ...env, ...patch };
      const login = await postLogin(worker, e, TEST_APP_PASSWORD);
      assert.equal(login.status, 503);
      assert.deepEqual(login.headers.getSetCookie(), []);
      assert.match(await login.text(), /Login is not configured/);
      // Even an empty submitted password never matches an empty or missing secret.
      assert.equal((await postLogin(worker, e, "")).status, 503);

      const page = await get("/", { e });
      assert.equal(page.status, 503);
      assert.match(await page.text(), /Login is not configured/);

      for (const path of ["/api/history", "/api/analytics"]) {
        const res = await caller(worker, e)(path);
        assert.equal(res.status, 503, path);
        assert.equal(res.data.detail, "Login is not configured.");
      }
      const health = await get("/api/health", { e });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });
    });
  }
});

describe("sessions", () => {
  test("a valid session opens the app and the private APIs", async () => {
    const { cookie } = await logIn(worker, env);
    assetCalls.length = 0;
    const page = await get("/", { cookie });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "app");
    assert.equal((await get("/assets/index-abc.js", { cookie })).status, 200);
    assert.deepEqual(assetCalls, ["/", "/assets/index-abc.js"]);
    assert.equal((await call("/api/history", { cookie })).status, 200);
    assert.equal((await call("/api/analytics", { cookie })).status, 200);
  });

  test("forged, malformed or foreign cookies are refused", async () => {
    const { cookie } = await logIn(worker, env);
    const token = tokenOf(cookie);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [
      `${SESSION_COOKIE}=${flipped}`, `${SESSION_COOKIE}=${"A".repeat(43)}`, `${SESSION_COOKIE}=${token}x`, `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=' OR 1=1 --`, `motion-atlas-session=${token}`, `other=${token}`, "better-auth.session_token=x.y",
    ]) {
      assert.equal((await call("/api/history", { cookie: bad })).status, 401, bad);
    }
    assert.equal((await call("/api/history", { cookie: `other=1; ${cookie}` })).status, 200, "found among other cookies");
  });

  test("each login is its own session", async () => {
    const a = await logIn(worker, env), b = await logIn(worker, env);
    assert.notEqual(a.cookie, b.cookie);
  });

  test("an expired session is refused, and expired rows are cleaned up on the next login", async () => {
    const { cookie } = await logIn(worker, env);
    const hash = await hashOf(tokenOf(cookie));
    assert.equal((await call("/api/history", { cookie })).status, 200);
    await env.DB.prepare("UPDATE app_session SET expires_at = ?1 WHERE token_hash = ?2").bind(Date.now() - 1, hash).run();
    assert.equal((await call("/api/history", { cookie })).status, 401);
    const page = await get("/", { cookie });
    assert.match(await page.text(), /Team password/, "the login page is shown again");

    await createSession(env.DB);
    assert.equal(await env.DB.prepare("SELECT 1 FROM app_session WHERE token_hash = ?1").bind(hash).first(), null);
  });
});

describe("logging out", () => {
  test("ends the session on the server and clears the cookie; other sessions keep working", async () => {
    const mine = await logIn(worker, env), other = await logIn(worker, env);
    const res = await get("/api/logout", { cookie: mine.cookie, method: "POST", headers: { origin: "http://app.test" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    const [cleared] = res.headers.getSetCookie();
    assert.match(cleared, new RegExp(`^${SESSION_COOKIE}=;`));
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /HttpOnly/);
    assert.match(cleared, /Secure/);
    assert.equal(await env.DB.prepare("SELECT 1 FROM app_session WHERE token_hash = ?1").bind(await hashOf(tokenOf(mine.cookie))).first(), null);
    assert.equal((await call("/api/history", { cookie: mine.cookie })).status, 401, "a copy of the old cookie no longer works");
    assert.equal((await call("/api/history", { cookie: other.cookie })).status, 200);
  });

  test("needs POST from this site; without a session it still clears the cookie", async () => {
    const { cookie } = await logIn(worker, env);
    assert.equal((await get("/api/logout", { cookie })).status, 405);
    const crossSite = await get("/api/logout", { cookie, method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await call("/api/history", { cookie })).status, 200, "a cross-site logout attempt changes nothing");
    const anon = await get("/api/logout", { method: "POST" });
    assert.equal(anon.status, 303);
    assert.match(anon.headers.getSetCookie()[0], /Max-Age=0/);
  });
});

describe("access control", () => {
  const id = crypto.randomUUID();
  const PRIVATE = [
    ["POST", "/api/analyze/keypoints", '{"frames":[[[0,0,0]]]}'],
    ["GET", "/api/history"], ["POST", "/api/history", JSON.stringify(sampleSave())],
    ["GET", `/api/history/${id}`], ["DELETE", `/api/history/${id}`],
    ["GET", "/api/analytics"],
    ["GET", "/api/anything-else"],
  ];
  // The Better Auth account routes were removed: no sign-up, account login, email OTP or session API.
  const REMOVED = [
    ["POST", "/api/auth/sign-up/email", '{"email":"a@b.test","password":"x","name":"x"}'],
    ["POST", "/api/auth/sign-in/email", '{"email":"a@b.test","password":"x"}'],
    ["POST", "/api/auth/email-otp/send-verification-otp", '{"email":"a@b.test","type":"sign-in"}'],
    ["POST", "/api/auth/sign-in/email-otp", '{"email":"a@b.test","otp":"123456"}'],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out", "{}"],
  ];
  const send = (method, path, body, cookie) => worker.fetch(new Request(`http://app.test${path}`, {
    method, body,
    headers: { ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}), ...(cookie ? { cookie } : {}) },
  }), env);

  test("every private API answers 401 without a session", async () => {
    for (const [method, path, body] of [...PRIVATE, ...REMOVED]) {
      const res = await send(method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).detail, "Please log in to use Motion Atlas.");
      assert.deepEqual(res.headers.getSetCookie(), [], `${method} ${path} sets no cookie`);
    }
  });

  test("the old account routes don't exist, even with a session", async () => {
    const { cookie } = await logIn(worker, env);
    for (const [method, path, body] of REMOVED) {
      const res = await send(method, path, body, cookie);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(res.headers.getSetCookie(), []);
    }
  });

  test("the app and its files are not served without a session; the login page is", async () => {
    assetCalls.length = 0;
    for (const path of ["/", "/index.html", "/assets/index-abc.js", "/graphs/model.html", "/some/deep/link"]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const html = await res.text();
      assert.match(html, /Team password/, path);
      assert.doesNotMatch(html, /<script/, "no app code before login");
    }
    assert.equal((await get("/", { method: "POST" })).status, 401);
    assert.deepEqual(assetCalls, [], "no app file was read");
  });

  test("public without a session: the health check and the login page's icons", async () => {
    assetCalls.length = 0;
    const health = await get("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal((await get("/api/health", { method: "POST" })).status, 405);
    for (const icon of ["/favicon.png", "/apple-touch-icon.png"]) assert.equal((await get(icon)).status, 200, icon);
    assert.deepEqual(assetCalls, ["/favicon.png", "/apple-touch-icon.png"]);
  });

  test("with a session, state-changing requests from another site are refused", async () => {
    const { cookie } = await logIn(worker, env);
    const res = await worker.fetch(new Request("http://app.test/api/history", {
      method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(sampleSave()),
    }), env);
    assert.equal(res.status, 403);
    const same = await worker.fetch(new Request("http://app.test/api/history", {
      method: "POST", headers: { cookie, origin: "http://app.test", "content-type": "application/json" }, body: JSON.stringify(sampleSave()),
    }), env);
    assert.equal(same.status, 201);
  });
});

describe("deployment config", () => {
  test("the Worker runs before every request and has the ASSETS binding it serves the app with", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { APP_DIR } = await import("./helpers.mjs");
    const raw = await readFile(join(APP_DIR, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/[^"\n]*$/gm, ""));
    assert.equal(config.assets.run_worker_first, true, "otherwise the page and its files would skip the gate");
    assert.equal(config.assets.binding, "ASSETS", "otherwise env.ASSETS is undefined and the logged-in app can't load");
    assert.equal(config.vars?.APP_PASSWORD, undefined, "the password is a secret, never a var in wrangler.jsonc");
    assert.doesNotMatch(raw, /"APP_PASSWORD"/, "no APP_PASSWORD key anywhere in wrangler.jsonc");
  });
});

describe("the password never reaches the client", () => {
  test("the login page and the app source never contain the password or the secret's name", async () => {
    const html = await (await get("/")).text();
    assert.ok(!html.includes(TEST_APP_PASSWORD));
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { APP_DIR } = await import("./helpers.mjs");
    const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))).flat();
    for (const file of (await walk(join(APP_DIR, "src"))).filter((f) => /\.(ts|tsx)$/.test(f))) {
      assert.doesNotMatch(await readFile(file, "utf8"), /APP_PASSWORD/, file);
    }
  });
});
