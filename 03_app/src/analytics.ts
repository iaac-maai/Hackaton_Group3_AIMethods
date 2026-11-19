// Analytics dashboard data: the signed-in user's own saved History summaries (Worker -> D1), and the
// pure calculations the dashboard shows. Nothing here sends or stores video, keypoints, file names
// or any ID: the Worker decides whose records to return from the login session alone.
//
// Window counts and flags come from the saved records, which were scored against each record's
// stored threshold. Flagged windows are movement deviations from the model's reference data, not
// measures of fatigue, workload, injury risk or safety.

export interface AnalyticsRecord {
  created_at: string;          // ISO timestamp
  analysis_type: string;       // "video" is the only type the app saves today
  duration_seconds: number | null;
  window_count: number;
  flagged_count: number;
  flagged_percent: number;
  model: string;
  threshold: number;
}

export interface AnalyticsData {
  records: AnalyticsRecord[];
  retention_limit: number;
}

interface Options {
  fetch?: typeof fetch;
}

export class AnalyticsError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AnalyticsError";
    this.status = status;
  }
}

/** Load the signed-in user's analytics records. Sends the session cookie and nothing else. */
export async function loadAnalytics(opts: Options = {}): Promise<AnalyticsData> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch("/api/analytics", { method: "GET", credentials: "same-origin" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new AnalyticsError(
      typeof detail === "string" ? detail : `Analytics request failed (HTTP ${res.status}).`,
      res.status,
    );
  }
  if (!data || !Array.isArray((data as AnalyticsData).records)) {
    throw new AnalyticsError("The analytics response was not in the expected format.", res.status);
  }
  return data as AnalyticsData;
}

export const TYPE_LABELS: Record<string, string> = {
  video: "Video analysis",
  imu: "IMU analysis",
};

export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

export interface Totals {
  analyses: number;
  windows: number;
  flaggedWindows: number;
  /** Flagged share of all windows (window-weighted), 0–100, or null with no windows. */
  flaggedPercent: number | null;
  /** Mean of each analysis's own flagged %, 0–100, or null with no analyses. */
  meanAnalysisPercent: number | null;
  /** Analyses with at least one flagged window. */
  analysesWithFlags: number;
  /** Total clip time of analyses whose duration is known. */
  durationSeconds: number;
  unknownDurations: number;
  first: Date | null;
  last: Date | null;
}

export interface TypeCount {
  type: string;
  label: string;
  analyses: number;
  windows: number;
  flaggedWindows: number;
  flaggedPercent: number | null;
}

export type Granularity = "day" | "week" | "month";

export interface Bucket {
  key: string;        // stable key (local date of the bucket start, YYYY-MM-DD)
  start: Date;        // local start of the day/week/month
  analyses: number;
  windows: number;
  flaggedWindows: number;
  /** Flagged share of the bucket's windows, or null when no analyses fall in it (a gap, not 0%). */
  flaggedPercent: number | null;
}

export interface Analytics {
  totals: Totals;
  byType: TypeCount[];
  granularity: Granularity;
  buckets: Bucket[];
  /** True when the user has reached the retention limit, so older analyses may have been removed. */
  atRetentionLimit: boolean;
  retentionLimit: number;
  /** Distinct (model, threshold) pairs: flags are only comparable within one pair. */
  scoringVersions: { model: string; threshold: number; analyses: number }[];
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local start of the day/week (Monday)/month containing `d`. */
export function bucketStart(d: Date, g: Granularity): Date {
  if (g === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === "week") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

function nextBucket(d: Date, g: Granularity): Date {
  if (g === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (g === "week" ? 7 : 1));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days for up to a month of data, weeks up to ~6 months, months beyond. */
export function chooseGranularity(first: Date, last: Date): Granularity {
  const span = (last.getTime() - first.getTime()) / DAY_MS;
  if (span <= 31) return "day";
  if (span <= 183) return "week";
  return "month";
}

const MAX_BUCKETS = 120;

/** Group records into consecutive day/week/month buckets, including empty ones between them. */
export function bucketize(records: AnalyticsRecord[], g: Granularity): Bucket[] {
  if (records.length === 0) return [];
  const dates = records.map((r) => new Date(r.created_at));
  const t = dates.map((d) => d.getTime());
  const first = bucketStart(new Date(Math.min(...t)), g);
  const last = bucketStart(new Date(Math.max(...t)), g);

  const buckets = new Map<string, Bucket>();
  for (let d = first; d.getTime() <= last.getTime() && buckets.size < MAX_BUCKETS; d = nextBucket(d, g)) {
    buckets.set(dateKey(d), { key: dateKey(d), start: d, analyses: 0, windows: 0, flaggedWindows: 0, flaggedPercent: null });
  }
  records.forEach((r, i) => {
    const b = buckets.get(dateKey(bucketStart(dates[i], g)));
    if (!b) return;
    b.analyses += 1;
    b.windows += r.window_count;
    b.flaggedWindows += r.flagged_count;
  });
  const out = [...buckets.values()];
  for (const b of out) b.flaggedPercent = b.analyses ? pct(b.flaggedWindows, b.windows) : null;
  return out;
}

/** Everything the dashboard shows, computed from the saved summaries only. */
export function computeAnalytics(data: AnalyticsData): Analytics {
  const records = data.records
    .filter((r) => !Number.isNaN(Date.parse(r.created_at)))
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const windows = records.reduce((s, r) => s + r.window_count, 0);
  const flaggedWindows = records.reduce((s, r) => s + r.flagged_count, 0);
  const known = records.filter((r) => r.duration_seconds != null);
  const first = records.length ? new Date(records[0].created_at) : null;
  const last = records.length ? new Date(records[records.length - 1].created_at) : null;

  const totals: Totals = {
    analyses: records.length,
    windows,
    flaggedWindows,
    flaggedPercent: pct(flaggedWindows, windows),
    meanAnalysisPercent: records.length
      ? Math.round((records.reduce((s, r) => s + r.flagged_percent, 0) / records.length) * 10) / 10
      : null,
    analysesWithFlags: records.filter((r) => r.flagged_count > 0).length,
    durationSeconds: Math.round(known.reduce((s, r) => s + (r.duration_seconds ?? 0), 0) * 10) / 10,
    unknownDurations: records.length - known.length,
    first,
    last,
  };

  const types = new Map<string, TypeCount>();
  for (const r of records) {
    const t = types.get(r.analysis_type) ?? {
      type: r.analysis_type, label: typeLabel(r.analysis_type), analyses: 0, windows: 0, flaggedWindows: 0, flaggedPercent: null,
    };
    t.analyses += 1;
    t.windows += r.window_count;
    t.flaggedWindows += r.flagged_count;
    types.set(r.analysis_type, t);
  }
  const byType = [...types.values()]
    .map((t) => ({ ...t, flaggedPercent: pct(t.flaggedWindows, t.windows) }))
    .sort((a, b) => b.analyses - a.analyses || a.type.localeCompare(b.type));

  const versions = new Map<string, { model: string; threshold: number; analyses: number }>();
  for (const r of records) {
    const k = `${r.model}\u0000${r.threshold}`;
    const v = versions.get(k) ?? { model: r.model, threshold: r.threshold, analyses: 0 };
    v.analyses += 1;
    versions.set(k, v);
  }

  const granularity = first && last ? chooseGranularity(first, last) : "day";

  return {
    totals,
    byType,
    granularity,
    buckets: bucketize(records, granularity),
    atRetentionLimit: records.length >= data.retention_limit,
    retentionLimit: data.retention_limit,
    scoringVersions: [...versions.values()],
  };
}

const PERIOD_WORD: Record<Granularity, string> = { day: "day", week: "week", month: "month" };

export const periodWord = (g: Granularity) => PERIOD_WORD[g];

/** Label for a bucket, e.g. "3 Nov", "week of 3 Nov", "Nov 2026". */
export function bucketLabel(b: Bucket, g: Granularity, locale?: string): string {
  if (g === "month") return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(b.start);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(b.start);
  return g === "week" ? `week of ${day}` : day;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain-language summary of the whole dashboard, for screen readers and as a visible lead. */
export function describeAnalytics(a: Analytics, locale?: string): string {
  const t = a.totals;
  if (t.analyses === 0) return "You have no saved analyses yet.";
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const range = t.first && t.last && dateKey(t.first) !== dateKey(t.last)
    ? `between ${fmt.format(t.first)} and ${fmt.format(t.last)}`
    : `on ${fmt.format(t.first!)}`;
  const parts = [
    `${plural(t.analyses, "saved analysis", "saved analyses")} ${range}.`,
    `${plural(t.flaggedWindows, "window")} of ${plural(t.windows, "scored window")} ` +
      `(${t.flaggedPercent ?? 0}%) were above the threshold, in ${plural(t.analysesWithFlags, "analysis", "analyses")}.`,
  ];
  const trend = describeTrend(a);
  if (trend) parts.push(trend);
  return parts.join(" ");
}

/**
 * Compare the flagged share in the first and second half of the periods that have data.
 * Descriptive only: a small change between a few clips says little.
 */
export function describeTrend(a: Analytics): string | null {
  const withData = a.buckets.filter((b) => b.flaggedPercent != null);
  if (withData.length < 4) return null;
  const half = Math.floor(withData.length / 2);
  const share = (bs: Bucket[]) => {
    const w = bs.reduce((s, b) => s + b.windows, 0);
    return w ? (bs.reduce((s, b) => s + b.flaggedWindows, 0) / w) * 100 : 0;
  };
  const early = share(withData.slice(0, half));
  const late = share(withData.slice(withData.length - half));
  const diff = Math.round((late - early) * 10) / 10;
  const word = periodWord(a.granularity);
  if (Math.abs(diff) < 5) return `The flagged share was similar in your earlier and more recent ${word}s.`;
  return `The flagged share was ${diff > 0 ? "higher" : "lower"} in your more recent ${word}s ` +
    `(${Math.round(late)}% vs ${Math.round(early)}%).`;
}
