/**
 * Motion Atlas Cloudflare Worker
 *
 * - Runs before every request (assets.run_worker_first): a shared team password gates the whole app
 * - Serves the React frontend only after login; the login page itself is server-rendered
 * - Forwards keypoints to the Render ML API
 * - Stores analysis summaries in Cloudflare D1, in one History shared by everyone with the password
 *
 * Public without login: GET /api/health (model wake-up), POST /api/login, POST /api/logout and the
 * favicon files the login page uses. Everything else needs a valid session cookie.
 *
 * Video is processed locally in the browser.
 */

import { handleHistory, SHARED_HISTORY_OWNER, type HistoryEnv } from "./history.ts";
import { handleAnalytics } from "./analytics.ts";
import {
  clearedSessionCookie, createSession, deleteSession, hasValidSession, LOGIN_MAX_BYTES, LOGIN_MESSAGE,
  loginPage, NOT_CONFIGURED_MESSAGE, passwordMatches, PUBLIC_ASSETS, sameOrigin, sessionCookie,
} from "./gate.ts";
import type { D1Database } from "@cloudflare/workers-types";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends HistoryEnv {
  ASSETS: AssetsBinding;
  RENDER_API_URL: string;
  /** The shared team password (Worker secret). Never in code, config or Git. */
  APP_PASSWORD?: string;
  DB: D1Database;
}

const MAX_KEYPOINT_BYTES = 8 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 150_000;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const redirectHome = (cookie: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": cookie, "cache-control": "no-store" },
  });

async function forward(
  env: Env,
  path: string,
  init: RequestInit
): Promise<Response> {
  const base = (env.RENDER_API_URL ?? "")
    .trim()
    .replace(/\/+$/, "");

  if (!base) {
    return json(503, {
      detail: "RENDER_API_URL is not configured for this Worker.",
    });
  }

  let upstream: Response;

  try {
    upstream = await fetch(base + path, {
      ...init,
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof DOMException &&
      err.name === "TimeoutError";

    return json(timedOut ? 504 : 502, {
      detail: timedOut
        ? "The model server did not answer in time. It may still be waking up; try again in a minute."
        : "Could not reach the model server.",
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ??
        "application/json",
    },
  });
}

/** POST /api/login with form field `password`. Success sets the session cookie and redirects to the app. */
async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json(405, { detail: "Use POST." });
  if (!env.APP_PASSWORD || !env.DB) {
    return loginPage({ status: 503, error: `${NOT_CONFIGURED_MESSAGE} Ask the team to set it up.` });
  }
  if (!sameOrigin(request, url)) {
    return loginPage({ status: 403, error: "This login form was sent from another site." });
  }

  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded")) {
    return loginPage({ status: 415, error: "Send the password from the login form." });
  }
  if (Number(request.headers.get("content-length") ?? "0") > LOGIN_MAX_BYTES) {
    return loginPage({ status: 413, error: "That request is too large." });
  }

  let password: string;
  try {
    const body = await request.text();
    if (body.length > LOGIN_MAX_BYTES) return loginPage({ status: 413, error: "That request is too large." });
    password = new URLSearchParams(body).get("password") ?? "";
  } catch {
    return loginPage({ status: 400, error: "Could not read the login form." });
  }

  if (!password || !(await passwordMatches(password, env.APP_PASSWORD))) {
    return loginPage({ status: 401, error: "That password isn’t right." });
  }

  try {
    return redirectHome(sessionCookie(await createSession(env.DB)));
  } catch (err) {
    console.error("session create error", err);
    return loginPage({ status: 500, error: "Could not start a session. Please try again." });
  }
}

/** POST /api/logout: ends the session on the server and clears the cookie. */
async function handleLogout(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json(405, { detail: "Use POST." });
  if (!sameOrigin(request, url)) return json(403, { detail: "Cross-site request refused." });
  if (env.DB) {
    try {
      await deleteSession(env.DB, request);
    } catch (err) {
      console.error("session delete error", err);
      return json(500, { detail: "Could not log out. Please try again." });
    }
  }
  return redirectHome(clearedSessionCookie());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const isApi = pathname.startsWith("/api/");
    const isRead = request.method === "GET" || request.method === "HEAD";

    // 1. Public: Render model health check (the app's wake-up call)
    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        return json(405, {
          detail: "Use GET.",
        });
      }

      return forward(env, "/health", {
        method: "GET",
      });
    }

    // 2. Public: log in, log out, and the icons the login page uses
    if (pathname === "/api/login") return handleLogin(request, env, url);
    if (pathname === "/api/logout") return handleLogout(request, env, url);
    if (PUBLIC_ASSETS.has(pathname) && isRead) return env.ASSETS.fetch(request);

    // 3. Everything else needs the gate to be configured...
    if (!env.APP_PASSWORD || !env.DB) {
      return isApi
        ? json(503, { detail: NOT_CONFIGURED_MESSAGE })
        : loginPage({ status: 503, error: `${NOT_CONFIGURED_MESSAGE} Ask the team to set it up.` });
    }

    // ...and a valid session cookie
    let loggedIn: boolean;
    try {
      loggedIn = await hasValidSession(env.DB, request);
    } catch (err) {
      console.error("session verification error", err);
      return isApi
        ? json(500, { detail: "Could not verify your session." })
        : loginPage({ status: 500, error: "Could not verify your session. Please try again." });
    }

    if (!loggedIn) {
      if (isApi) return json(401, { detail: LOGIN_MESSAGE });
      return loginPage({ status: isRead ? 200 : 401 });
    }

    // Logged in: refuse state-changing requests sent from another site (CSRF)
    if (!isRead && !sameOrigin(request, url)) {
      return json(403, { detail: "Cross-site request refused." });
    }

    // 4. Analyze keypoints using the Render API
    if (pathname === "/api/analyze/keypoints") {
      if (request.method !== "POST") {
        return json(405, {
          detail: "Use POST.",
        });
      }

      if (
        !(request.headers.get("content-type") ?? "")
          .includes("application/json")
      ) {
        return json(415, {
          detail: "Send keypoints as application/json.",
        });
      }

      const length = Number(
        request.headers.get("content-length")
      );

      if (!length) {
        return json(411, {
          detail: "Content-Length is required.",
        });
      }

      if (length > MAX_KEYPOINT_BYTES) {
        return json(413, {
          detail:
            "Keypoint payload is too large; use a shorter clip.",
        });
      }

      return forward(env, "/predict/keypoints", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: request.body,
      });
    }

    // 5. Analysis history in Cloudflare D1: one History shared by everyone with the team password
    if (pathname === "/api/history" || pathname.startsWith("/api/history/")) {
      try {
        return await handleHistory(
          request,
          env,
          pathname,
          SHARED_HISTORY_OWNER
        );
      } catch (err) {
        console.error("history route error", err);

        return json(500, {
          detail: "History request failed.",
        });
      }
    }

    // 6. Analytics: summaries of the shared History
    if (pathname === "/api/analytics") {
      return handleAnalytics(request, env, SHARED_HISTORY_OWNER);
    }

    // 7. Unknown API routes (including the removed /api/auth/* account routes)
    if (isApi) {
      return json(404, {
        detail: "Unknown API route.",
      });
    }

    // 8. Serve the React application
    return env.ASSETS.fetch(request);
  },
};
