
import type { D1Database } from "@cloudflare/workers-types";

// Saved analysis history in D1.
// Every row has an owner in the browser_id column (the name predates logins), and every query is
// scoped to one owner. The Worker passes the owner after its own login check, never from the request.
//
// With the shared team password there is one owner, SHARED_HISTORY_OWNER: everyone who logs in sees,
// opens and deletes the same History. Rows saved earlier under other owners (Better Auth user IDs, or
// random browser IDs from before logins) are kept in D1 but are not listed, opened, deleted or pruned
// by these routes. See the app README ("History is shared") for how to adopt them, if wanted.
// Never trust a browser-supplied ID for access control.

/** The single History owner for everyone who logs in with the shared team password. */
export const SHARED_HISTORY_OWNER = "shared-team";

export interface HistoryEnv {
  DB?: D1Database;
}

export const LIST_DEFAULT = 20;
export const LIST_MAX = 50;
export const MAX_WINDOWS = 2000;
export const MAX_SAVE_BYTES = 256 * 1024;
export const MAX_RECORDS_PER_OWNER = 100;

const MAX_DURATION_S = 6 * 60 * 60;
const MAX_SUMMARY_KEYS = 20;

const TYPE_LABELS = {
  video: "Video analysis",
} as const;

type AnalysisType = keyof typeof TYPE_LABELS;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export interface SavedWindow {
  window: number;
  start_seconds: number;
  end_seconds: number;
  reconstruction_score: number;
  above_threshold: boolean;
}

export interface SaveRequest {
  analysis_type: AnalysisType;
  duration_seconds: number | null;
  model: string;
  threshold: number;
  interpretation: string;
  posture_summary: Record<string, number | string>;
  windows: SavedWindow[];
}

type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string };

const SAVE_FIELDS = new Set([
  "analysis_type",
  "duration_seconds",
  "model",
  "threshold",
  "interpretation",
  "posture_summary",
  "windows",
]);

const WINDOW_FIELDS = new Set([
  "window",
  "start_seconds",
  "end_seconds",
  "reconstruction_score",
  "above_threshold",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isText = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

export function parseSaveRequest(body: unknown): Parsed<SaveRequest> {
  const fail = (detail: string): Parsed<SaveRequest> => ({
    ok: false,
    detail,
  });

  if (!isObject(body)) {
    return fail("Send the analysis summary as a JSON object.");
  }

  for (const key of Object.keys(body)) {
    if (!SAVE_FIELDS.has(key)) {
      return fail(
        `Unexpected field "${key.slice(0, 40)}". Only analysis summaries can be saved.`
      );
    }
  }

  const {
    analysis_type,
    duration_seconds,
    model,
    threshold,
    interpretation = "",
    posture_summary = {},
    windows,
  } = body;

  if (
    typeof analysis_type !== "string" ||
    !(analysis_type in TYPE_LABELS)
  ) {
    return fail(
      `analysis_type must be one of: ${Object.keys(TYPE_LABELS).join(", ")}.`
    );
  }

  if (
    duration_seconds != null &&
    !(
      isNum(duration_seconds) &&
      duration_seconds > 0 &&
      duration_seconds <= MAX_DURATION_S
    )
  ) {
    return fail(
      `duration_seconds must be null or a number between 0 and ${MAX_DURATION_S}.`
    );
  }

  if (!isText(model, 100) || !model.trim()) {
    return fail(
      "model must be a non-empty string of at most 100 characters."
    );
  }

  if (!isNum(threshold) || threshold < 0) {
    return fail("threshold must be a non-negative number.");
  }

  if (!isText(interpretation, 500)) {
    return fail(
      "interpretation must be a string of at most 500 characters."
    );
  }

  if (!isObject(posture_summary)) {
    return fail("posture_summary must be an object.");
  }

  const summary = Object.entries(posture_summary);

  if (summary.length > MAX_SUMMARY_KEYS) {
    return fail(
      `posture_summary may have at most ${MAX_SUMMARY_KEYS} entries.`
    );
  }

  for (const [k, v] of summary) {
    if (!isText(k, 80) || !(isNum(v) || isText(v, 300))) {
      return fail(
        "posture_summary values must be numbers or short strings."
      );
    }
  }

  if (!Array.isArray(windows) || windows.length === 0) {
    return fail("windows must be a non-empty array.");
  }

  if (windows.length > MAX_WINDOWS) {
    return fail(`At most ${MAX_WINDOWS} windows can be saved.`);
  }

  const clean: SavedWindow[] = [];

  for (const [i, w] of windows.entries()) {
    if (
      !isObject(w) ||
      Object.keys(w).some((k) => !WINDOW_FIELDS.has(k))
    ) {
      return fail(
        `windows[${i}] must have only: ${[...WINDOW_FIELDS].join(", ")}.`
      );
    }

    const {
      window,
      start_seconds,
      end_seconds,
      reconstruction_score,
      above_threshold,
    } = w;

    if (
      !(
        Number.isInteger(window) &&
        (window as number) >= 0 &&
        (window as number) <= 1_000_000
      ) ||
      !(
        isNum(start_seconds) &&
        start_seconds >= 0 &&
        start_seconds <= MAX_DURATION_S
      ) ||
      !(
        isNum(end_seconds) &&
        end_seconds > start_seconds &&
        end_seconds <= MAX_DURATION_S
      ) ||
      !(
        isNum(reconstruction_score) &&
        reconstruction_score >= 0
      ) ||
      typeof above_threshold !== "boolean"
    ) {
      return fail(
        `windows[${i}] has a missing or invalid value.`
      );
    }

    clean.push({
      window: window as number,
      start_seconds,
      end_seconds,
      reconstruction_score,
      above_threshold,
    });
  }

  return {
    ok: true,
    value: {
      analysis_type: analysis_type as AnalysisType,
      duration_seconds: duration_seconds ?? null,
      model: model.trim(),
      threshold,
      interpretation,
      posture_summary: Object.fromEntries(summary) as Record<
        string,
        number | string
      >,
      windows: clean,
    },
  };
}

interface ListRow {
  id: string;
  created_at: number;
  analysis_type: string;
  duration_seconds: number | null;
  window_count: number;
  flagged_count: number;
  flagged_percent: number;
}

interface FullRow extends ListRow {
  model: string;
  threshold: number;
  interpretation: string;
  summary_json: string;
  windows_json: string;
}

const LIST_COLUMNS =
  "id, created_at, analysis_type, duration_seconds, window_count, flagged_count, flagged_percent";

function listItem(r: ListRow) {
  return {
    id: r.id,
    created_at: new Date(r.created_at).toISOString(),
    analysis_type: r.analysis_type,
    label:
      TYPE_LABELS[r.analysis_type as AnalysisType] ?? "Analysis",
    duration_seconds: r.duration_seconds,
    window_count: r.window_count,
    flagged_count: r.flagged_count,
    flagged_percent: r.flagged_percent,
  };
}

function fullItem(r: FullRow) {
  const packed = JSON.parse(r.windows_json) as [
    number,
    number,
    number,
    number,
    number
  ][];

  return {
    ...listItem(r),
    model: r.model,
    threshold: r.threshold,
    interpretation: r.interpretation,
    posture_summary: JSON.parse(r.summary_json) as Record<
      string,
      number | string
    >,
    windows: packed.map(
      ([
        window,
        start_seconds,
        end_seconds,
        reconstruction_score,
        flagged,
      ]) => ({
        window,
        start_seconds,
        end_seconds,
        reconstruction_score,
        above_threshold: flagged === 1,
      })
    ),
  };
}

async function readLimited(
  request: Request,
  max: number
): Promise<string | null> {
  const declared = Number(
    request.headers.get("content-length")
  );

  if (declared > max) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.byteLength;

    if (size > max) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  const all = new Uint8Array(size);
  let at = 0;

  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }

  return new TextDecoder().decode(all);
}

/**
 * Handle history requests for one owner, after the Worker has checked the login session.
 *
 * ownerId MUST be chosen by the Worker (today always SHARED_HISTORY_OWNER).
 * Never accept ownerId from headers, query parameters, or request bodies.
 */
export async function handleHistory(
  request: Request,
  env: HistoryEnv,
  pathname: string,
  ownerId: string
): Promise<Response> {
  if (!ownerId || typeof ownerId !== "string") {
    return json(401, {
      detail: "Please log in to use Motion Atlas.",
    });
  }

  const rest = pathname.slice("/api/history".length);

  if (rest !== "" && !/^\/[^/]+$/.test(rest)) {
    return json(404, {
      detail: "Unknown history route.",
    });
  }

  const recordId = rest
    ? rest.slice(1).toLowerCase()
    : null;

  const method = request.method;

  if (
    recordId === null &&
    method !== "GET" &&
    method !== "POST"
  ) {
    return json(405, {
      detail: "Use GET to list or POST to save.",
    });
  }

  if (
    recordId !== null &&
    method !== "GET" &&
    method !== "DELETE"
  ) {
    return json(405, {
      detail: "Use GET to load or DELETE to remove a saved analysis.",
    });
  }

  if (recordId !== null && !UUID_RE.test(recordId)) {
    return json(400, {
      detail: "Invalid saved analysis ID.",
    });
  }

  const db = env.DB;

  if (!db) {
    return json(503, {
      detail:
        "History storage (D1 binding DB) is not configured for this Worker.",
    });
  }

  try {
    if (recordId === null && method === "GET") {
      return await list(
        db,
        ownerId,
        new URL(request.url).searchParams.get("limit")
      );
    }

    if (recordId === null) {
      return await save(db, ownerId, request);
    }

    if (method === "GET") {
      return await load(db, ownerId, recordId);
    }

    return await remove(db, ownerId, recordId);
  } catch (err) {
    console.error("history storage error", err);

    return json(500, {
      detail:
        "History storage failed. The analysis itself is not affected; try again later.",
    });
  }
}

async function list(
  db: D1Database,
  ownerId: string,
  rawLimit: string | null
): Promise<Response> {
  let limit = LIST_DEFAULT;

  if (rawLimit !== null) {
    if (
      !/^\d{1,3}$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > LIST_MAX
    ) {
      return json(400, {
        detail: `limit must be a whole number from 1 to ${LIST_MAX}.`,
      });
    }

    limit = Number(rawLimit);
  }

  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}
       FROM analysis_history
       WHERE browser_id = ?1
       ORDER BY created_at DESC, id DESC
       LIMIT ?2`
    )
    .bind(ownerId, limit)
    .all<ListRow>();

  return json(200, {
    items: results.map(listItem),
    limit,
  });
}

async function save(
  db: D1Database,
  ownerId: string,
  request: Request
): Promise<Response> {
  if (
    !(request.headers.get("content-type") ?? "").includes(
      "application/json"
    )
  ) {
    return json(415, {
      detail: "Send the analysis summary as application/json.",
    });
  }

  const text = await readLimited(
    request,
    MAX_SAVE_BYTES
  );

  if (text === null) {
    return json(413, {
      detail: `The analysis summary is larger than ${
        MAX_SAVE_BYTES / 1024
      } KiB.`,
    });
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return json(400, {
      detail: "The request body is not valid JSON.",
    });
  }

  const parsed = parseSaveRequest(body);

  if (!parsed.ok) {
    return json(400, {
      detail: parsed.detail,
    });
  }

  const s = parsed.value;
  const flagged = s.windows.filter(
    (w) => w.above_threshold
  ).length;

  const row: FullRow = {
    id: crypto.randomUUID(),
    created_at: Date.now(),
    analysis_type: s.analysis_type,
    duration_seconds: s.duration_seconds,
    window_count: s.windows.length,
    flagged_count: flagged,
    flagged_percent:
      Math.round(
        (flagged / s.windows.length) * 10000
      ) / 100,
    model: s.model,
    threshold: s.threshold,
    interpretation: s.interpretation,
    summary_json: JSON.stringify(
      s.posture_summary
    ),
    windows_json: JSON.stringify(
      s.windows.map((w) => [
        w.window,
        w.start_seconds,
        w.end_seconds,
        w.reconstruction_score,
        w.above_threshold ? 1 : 0,
      ])
    ),
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO analysis_history (
          id, browser_id, created_at, analysis_type,
          model, duration_seconds, window_count,
          flagged_count, flagged_percent, threshold,
          interpretation, summary_json, windows_json
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, ?11, ?12, ?13
        )`
      )
      .bind(
        row.id,
        ownerId,
        row.created_at,
        row.analysis_type,
        row.model,
        row.duration_seconds,
        row.window_count,
        row.flagged_count,
        row.flagged_percent,
        row.threshold,
        row.interpretation,
        row.summary_json,
        row.windows_json
      ),
    db
      .prepare(
        `DELETE FROM analysis_history
         WHERE browser_id = ?1
         AND id NOT IN (
           SELECT id
           FROM analysis_history
           WHERE browser_id = ?1
           ORDER BY created_at DESC, id DESC
           LIMIT ?2
         )`
      )
      .bind(ownerId, MAX_RECORDS_PER_OWNER),
  ]);

  return json(201, listItem(row));
}

async function load(
  db: D1Database,
  ownerId: string,
  id: string
): Promise<Response> {
  const row = await db
    .prepare(
      `SELECT ${LIST_COLUMNS},
        model, threshold, interpretation,
        summary_json, windows_json
       FROM analysis_history
       WHERE id = ?1 AND browser_id = ?2`
    )
    .bind(id, ownerId)
    .first<FullRow>();

  if (!row) {
    return json(404, {
      detail:
        "Saved analysis not found. It may have been deleted.",
    });
  }

  return json(200, fullItem(row));
}

async function remove(
  db: D1Database,
  ownerId: string,
  id: string
): Promise<Response> {
  const result = await db
    .prepare(
      `DELETE FROM analysis_history
       WHERE id = ?1 AND browser_id = ?2`
    )
    .bind(id, ownerId)
    .run();

  if (!result.meta.changes) {
    return json(404, {
      detail:
        "Saved analysis not found. It may already have been deleted.",
    });
  }

  return json(200, {
    deleted: id,
  });
}
