
/**
 * Motion Atlas Cloudflare Worker
 *
 * - Serves the React frontend
 * - Forwards keypoints to the Render ML API
 * - Stores analysis summaries in Cloudflare D1
 * - Handles Better Auth signup, login, and sessions
 * - Requires authentication for analysis and history APIs
 * - Scopes saved history (and the read-only analytics summary) to the authenticated user
 *
 * Video is processed locally in the browser.
 */

import { handleHistory, type HistoryEnv } from "./history.ts";
import { handleAnalytics } from "./analytics.ts";
import { createAuth } from "./auth.ts";
import type { D1Database } from "@cloudflare/workers-types";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends HistoryEnv {
  ASSETS: AssetsBinding;
  RENDER_API_URL: string;
  BETTER_AUTH_SECRET: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. Better Auth: signup, login, logout, sessions
    if (pathname.startsWith("/api/auth/")) {
      if (!env.BETTER_AUTH_SECRET) {
        return json(503, {
          detail: "Authentication is not configured.",
        });
      }

      const auth = createAuth(
        env.DB,
        env.BETTER_AUTH_SECRET,
        url.origin
      );

      return auth.handler(request);
    }

    // 2. Render model health check
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

    // 3. Identify protected routes
    const isHistoryRoute =
      pathname === "/api/history" ||
      pathname.startsWith("/api/history/");

    const isAnalysisRoute =
      pathname === "/api/analyze/keypoints";

    // Read-only summary of the user's own History records for the Analytics tab.
    const isAnalyticsRoute =
      pathname === "/api/analytics";

    const protectedRoute =
      isHistoryRoute || isAnalysisRoute || isAnalyticsRoute;

    // This value comes ONLY from the server-verified session.
    // Never read it from a request header or request body.
    let authenticatedUserId: string | null = null;

    // 4. Require login for analysis and history
    if (protectedRoute) {
      if (!env.BETTER_AUTH_SECRET) {
        return json(503, {
          detail: "Authentication is not configured.",
        });
      }

      const auth = createAuth(
        env.DB,
        env.BETTER_AUTH_SECRET,
        url.origin
      );

      let session;

      try {
        session = await auth.api.getSession({
          headers: request.headers,
        });
      } catch (err) {
        console.error("session verification error", err);

        return json(500, {
          detail: "Could not verify your session.",
        });
      }

      if (!session?.user?.id) {
        return json(401, {
          detail: "Please log in to use Motion Atlas.",
        });
      }

      authenticatedUserId = session.user.id;
    }

    // 5. Analyze keypoints using the Render API
    if (isAnalysisRoute) {
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

    // 6. Analysis history in Cloudflare D1
    if (isHistoryRoute) {
      if (!authenticatedUserId) {
        return json(401, {
          detail: "Please log in to use Motion Atlas.",
        });
      }

      try {
        return await handleHistory(
          request,
          env,
          pathname,
          authenticatedUserId
        );
      } catch (err) {
        console.error("history route error", err);

        return json(500, {
          detail: "History request failed.",
        });
      }
    }

    // 7. Analytics: summaries of the signed-in user's own History records
    if (isAnalyticsRoute) {
      if (!authenticatedUserId) {
        return json(401, {
          detail: "Please log in to use Motion Atlas.",
        });
      }

      return handleAnalytics(request, env, authenticatedUserId);
    }

    // 8. Unknown API routes
    if (pathname.startsWith("/api/")) {
      return json(404, {
        detail: "Unknown API route.",
      });
    }

    // 9. Serve the React application
    return env.ASSETS.fetch(request);
  },
};
