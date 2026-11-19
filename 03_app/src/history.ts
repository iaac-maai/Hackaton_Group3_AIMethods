
import type { KeypointResult } from "./api";

// Saved analysis history (Worker -> D1).
// Only summary data and per-window scores/times are sent.
// The Worker determines ownership from the authenticated Better Auth session.
// No browser-generated identifier is used for access control.

export interface HistoryItem {
  id: string;
  created_at: string;
  analysis_type: string;
  label: string;
  duration_seconds: number | null;
  window_count: number;
  flagged_count: number;
  flagged_percent: number;
}

export interface SavedAnalysis {
  item: HistoryItem;
  result: KeypointResult;
}

export type SaveOutcome =
  | { saved: true; item: HistoryItem }
  | { saved: false; message: string };

interface Options {
  fetch?: typeof fetch;
}

export function toSaveRequest(
  result: KeypointResult,
  durationS: number | null,
  windowS: number
) {
  return {
    analysis_type: "video",
    duration_seconds:
      durationS && durationS > 0
        ? Math.round(durationS * 1000) / 1000
        : null,
    model: result.model,
    threshold: result.threshold,
    interpretation: result.interpretation,
    posture_summary: result.posture_summary,
    windows: result.windows.map((w) => ({
      window: w.window,
      start_seconds: w.start_seconds,
      end_seconds:
        w.end_seconds ??
        Math.round((w.start_seconds + windowS) * 1000) / 1000,
      reconstruction_score: w.reconstruction_score,
      above_threshold: w.above_threshold,
    })),
  };
}

async function call<T>(
  path: string,
  init: RequestInit,
  opts: Options
): Promise<T> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  const res = await doFetch(path, {
    ...init,
    credentials: "same-origin",
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;

    throw new HistoryError(
      typeof detail === "string"
        ? detail
        : `History request failed (HTTP ${res.status}).`,
      res.status
    );
  }

  return data as T;
}

export class HistoryError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HistoryError";
    this.status = status;
  }
}

export function listHistory(
  opts: Options = {}
): Promise<HistoryItem[]> {
  return call<{ items: HistoryItem[] }>(
    "/api/history?limit=20",
    { method: "GET" },
    opts
  ).then((d) => d.items);
}

export async function loadHistory(
  id: string,
  opts: Options = {}
): Promise<SavedAnalysis> {
  const d = await call<
    HistoryItem &
      Omit<
        KeypointResult,
        | "windows_analyzed"
        | "windows_above_threshold"
        | "percentage_above_threshold"
      >
  >(
    `/api/history/${encodeURIComponent(id)}`,
    { method: "GET" },
    opts
  );

  const {
    model,
    threshold,
    interpretation,
    posture_summary,
    windows,
    ...item
  } = d;

  return {
    item,
    result: {
      model,
      threshold,
      interpretation,
      posture_summary,
      windows: windows.map((w) => ({
        ...w,
        start_sample: Math.round(w.start_seconds * 25),
      })),
      windows_analyzed: item.window_count,
      windows_above_threshold: item.flagged_count,
      percentage_above_threshold: item.flagged_percent,
    },
  };
}

export async function deleteHistory(
  id: string,
  opts: Options = {}
): Promise<void> {
  await call(
    `/api/history/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    opts
  );
}

// Saving history must never hide or invalidate the analysis result.
export async function persistAnalysis(
  result: KeypointResult,
  durationS: number | null,
  windowS: number,
  opts: Options = {}
): Promise<SaveOutcome> {
  try {
    const item = await call<HistoryItem>(
      "/api/history",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          toSaveRequest(result, durationS, windowS)
        ),
      },
      opts
    );

    return { saved: true, item };
  } catch (e) {
    const message =
      e instanceof HistoryError
        ? e.message
        : "Could not reach the history service.";

    return { saved: false, message };
  }
}
