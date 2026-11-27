import type { D1Database } from "@cloudflare/workers-types";
import { MAX_RECORDS_PER_OWNER, type HistoryEnv } from "./history.ts";

// Read-only data for the in-app Analytics dashboard.
//
// Returns the per-analysis summary columns of the shared History records (the same
// fields the History list already shows, plus the stored model name and threshold so the dashboard
// can tell when records were scored differently). Never per-window scores, posture numbers, video,
// keypoints or file names (none of the last three are stored anyway).
//
// Ownership uses the same rule as /api/history: ownerId is chosen by the Worker after its login check
// (the shared History owner) and matched against analysis_history.browser_id. Query parameters,
// headers and bodies are never used to choose whose data is read.

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

interface AnalyticsRow {
  created_at: number;
  analysis_type: string;
  duration_seconds: number | null;
  window_count: number;
  flagged_count: number;
  flagged_percent: number;
  model: string;
  threshold: number;
}

export async function handleAnalytics(
  request: Request,
  env: HistoryEnv,
  ownerId: string
): Promise<Response> {
  if (!ownerId || typeof ownerId !== "string") {
    return json(401, { detail: "Please log in to use Motion Atlas." });
  }

  if (request.method !== "GET") {
    return json(405, { detail: "Use GET." });
  }

  const db: D1Database | undefined = env.DB;

  if (!db) {
    return json(503, {
      detail:
        "History storage (D1 binding DB) is not configured for this Worker.",
    });
  }

  try {
    const { results } = await db
      .prepare(
        `SELECT created_at, analysis_type, duration_seconds, window_count,
                flagged_count, flagged_percent, model, threshold
         FROM analysis_history
         WHERE browser_id = ?1
         ORDER BY created_at ASC, id ASC
         LIMIT ?2`
      )
      .bind(ownerId, MAX_RECORDS_PER_OWNER)
      .all<AnalyticsRow>();

    return json(200, {
      records: results.map((r) => ({
        created_at: new Date(r.created_at).toISOString(),
        analysis_type: r.analysis_type,
        duration_seconds: r.duration_seconds,
        window_count: r.window_count,
        flagged_count: r.flagged_count,
        flagged_percent: r.flagged_percent,
        model: r.model,
        threshold: r.threshold,
      })),
      retention_limit: MAX_RECORDS_PER_OWNER,
    });
  } catch (err) {
    console.error("analytics storage error", err);

    return json(500, {
      detail: "Could not load your analytics. Try again later.",
    });
  }
}
