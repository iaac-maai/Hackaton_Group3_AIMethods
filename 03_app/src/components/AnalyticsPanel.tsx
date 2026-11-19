import { useEffect, useRef, useState } from "react";
import {
  bucketLabel, computeAnalytics, describeAnalytics, describeTrend, loadAnalytics, periodWord,
  type Analytics, type Bucket, type Granularity,
} from "../analytics";

// Analytics tab: summaries and trends of the signed-in user's own saved History records.
// Data comes only from the Worker's /api/analytics route, which reads the user's records from the
// login session. Nothing is tracked, sent to third parties, or stored by this view.

export type AnalyticsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; analytics: Analytics };

const DISCLAIMER =
  "Flagged windows are movement deviations from the model’s reference data. They are not measures of fatigue, " +
  "workload, injury risk or safety, and they are not a diagnosis.";

interface ViewProps {
  state: AnalyticsState;
  onRetry: () => void;
}

/** Pure view (no data loading), so each state can be rendered and tested on its own. */
export function AnalyticsView({ state, onRetry }: ViewProps) {
  return (
    <section className="analytics" aria-labelledby="analytics-title" aria-busy={state.kind === "loading"}>
      <h2 id="analytics-title">Your analytics</h2>
      <p className="muted analytics-intro">
        Built only from the summaries in your own History (saved single-person video analyses): dates, window counts
        and flagged-window counts. No video, keypoints or file names are used, and nothing is shared or tracked.
        Multi-person results aren’t saved to History, so they aren’t included.
      </p>
      <p className="analytics-disclaimer" role="note"><strong>Not a safety measure.</strong> {DISCLAIMER}</p>

      {state.kind === "loading" && <p role="status">Loading your analytics…</p>}

      {state.kind === "error" && (
        <div className="error-box" role="alert">
          <p>Could not load your analytics: {state.message}</p>
          <button onClick={onRetry}>Try again</button>
        </div>
      )}

      {state.kind === "ready" && state.analytics.totals.analyses === 0 && (
        <p className="muted analytics-empty" role="status">
          No saved analyses yet. Run a single-person video analysis on the Analysis tab; it’s saved to History
          automatically and will appear here.
        </p>
      )}

      {state.kind === "ready" && state.analytics.totals.analyses > 0 && <Dashboard a={state.analytics} />}
    </section>
  );
}

const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function fmtDuration(s: number): string {
  if (s < 60) return `${nf1.format(s)} s`;
  const m = Math.floor(s / 60), rest = Math.round(s % 60);
  if (m < 60) return `${m} min ${rest} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Dashboard({ a }: { a: Analytics }) {
  const t = a.totals;
  const word = periodWord(a.granularity);
  const trend = describeTrend(a);
  const mixedScoring = a.scoringVersions.length > 1;

  return (
    <>
      <p className="analytics-summary">{describeAnalytics(a)}</p>

      <p className={a.atRetentionLimit ? "analytics-limit warn" : "analytics-limit muted"} role="note">
        {a.atRetentionLimit
          ? <>⚠ You have reached the History limit of {a.retentionLimit} saved analyses. Older analyses have been removed
            as new ones were saved, so these figures cover only your newest {a.retentionLimit}, not your lifetime totals.</>
          : <>History keeps your newest {a.retentionLimit} analyses; older ones are removed as new ones are saved, and
            deleted analyses aren’t counted. These figures cover what’s in your History now.</>}
      </p>

      {mixedScoring && (
        <p className="analytics-limit warn" role="note">
          ⚠ Your analyses were scored with {a.scoringVersions.length} different model/threshold settings
          ({a.scoringVersions.map((v) => `${v.model} at ${v.threshold}: ${v.analyses}`).join("; ")}). Flagged shares
          from different settings aren’t directly comparable.
        </p>
      )}

      <dl className="analytics-tiles">
        <div className="tile"><dt>Saved analyses</dt><dd>{t.analyses}</dd></div>
        <div className="tile"><dt>Scored windows</dt><dd>{t.windows}</dd></div>
        <div className="tile">
          <dt>Flagged windows</dt>
          <dd>{t.flaggedWindows} <span className="muted">({t.flaggedPercent ?? 0}%)</span></dd>
        </div>
        <div className="tile">
          <dt>Analyses with a flag</dt>
          <dd>{t.analysesWithFlags} <span className="muted">of {t.analyses}</span></dd>
        </div>
        <div className="tile">
          <dt>Clip time analysed</dt>
          <dd>{fmtDuration(t.durationSeconds)}</dd>
          {t.unknownDurations > 0 && <span className="muted">{t.unknownDurations} without a known duration</span>}
        </div>
      </dl>

      <figure className="analytics-chart">
        <figcaption>
          <h3>Saved analyses per {word}</h3>
          <p className="muted">{countSummary(a)}</p>
        </figcaption>
        <BarChart buckets={a.buckets} granularity={a.granularity} />
      </figure>

      <figure className="analytics-chart">
        <figcaption>
          <h3>Flagged share of windows per {word}</h3>
          <p className="muted">
            Flagged windows ÷ all scored windows in that {word}. {word[0].toUpperCase() + word.slice(1)}s without a saved
            analysis are left blank, not shown as 0%. {trend ?? ""}
          </p>
        </figcaption>
        <PercentChart buckets={a.buckets} granularity={a.granularity} />
      </figure>

      <details className="analytics-table">
        <summary>Show the data as a table</summary>
        <table>
          <caption className="sr-only">Saved analyses and flagged windows per {word}</caption>
          <thead>
            <tr><th scope="col">{word[0].toUpperCase() + word.slice(1)}</th><th scope="col">Analyses</th>
              <th scope="col">Windows</th><th scope="col">Flagged</th><th scope="col">Flagged share</th></tr>
          </thead>
          <tbody>
            {a.buckets.map((b) => (
              <tr key={b.key}>
                <th scope="row">{bucketLabel(b, a.granularity)}</th>
                <td>{b.analyses}</td><td>{b.windows}</td><td>{b.flaggedWindows}</td>
                <td>{b.flaggedPercent == null ? "—" : `${b.flaggedPercent}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <section className="analytics-types" aria-labelledby="analytics-types-title">
        <h3 id="analytics-types-title">By analysis type</h3>
        {a.byType.length === 1 ? (
          <p className="muted">
            All {a.byType[0].analyses} saved analyses are {a.byType[0].label.toLowerCase().replace(/analysis$/, "analyses")}.
            Video is the only type the app saves to History today.
          </p>
        ) : (
          <table>
            <thead><tr><th scope="col">Type</th><th scope="col">Analyses</th><th scope="col">Windows</th>
              <th scope="col">Flagged share</th></tr></thead>
            <tbody>
              {a.byType.map((t) => (
                <tr key={t.type}><th scope="row">{t.label}</th><td>{t.analyses}</td><td>{t.windows}</td>
                  <td>{t.flaggedPercent == null ? "—" : `${t.flaggedPercent}%`}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function countSummary(a: Analytics): string {
  const word = periodWord(a.granularity);
  const active = a.buckets.filter((b) => b.analyses > 0);
  const busiest = active.reduce<Bucket | null>((m, b) => (!m || b.analyses > m.analyses ? b : m), null);
  const base = `${a.buckets.length} ${word}${a.buckets.length === 1 ? "" : "s"} shown, ${active.length} with saved analyses.`;
  return busiest && a.buckets.length > 1
    ? `${base} Most in one ${word}: ${busiest.analyses} (${bucketLabel(busiest, a.granularity)}).`
    : base;
}

// ---- charts (inline SVG, single series each; the data table above is the accessible view) ----

const PAD = { l: 40, r: 12, t: 14, b: 26 };
const HEIGHT = 180;

/** Width of the chart's container, so text stays at real pixel size on small screens. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Indices of the x labels to draw: first, last, and evenly spaced ones that fit. */
function labelIndices(n: number, width: number): Set<number> {
  const fit = Math.max(2, Math.floor((width - PAD.l - PAD.r) / 72));
  if (n <= fit) return new Set(Array.from({ length: n }, (_, i) => i));
  const step = Math.ceil((n - 1) / (fit - 1));
  const s = new Set<number>();
  let lastShown = 0;
  for (let i = 0; i < n; i += step) { s.add(i); lastShown = i; }
  // Always label the newest period, dropping the previous label if the two would collide.
  if (lastShown !== n - 1 && n - 1 - lastShown < step) s.delete(lastShown);
  s.add(n - 1);
  return s;
}

/** Compact x-axis label: the period's start date (the title names the period). */
const axisLabel = (b: Bucket, g: Granularity) => (g === "week" ? bucketLabel(b, "day") : bucketLabel(b, g));

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);   // rounded data end at the top, square on the baseline
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface ChartProps { buckets: Bucket[]; granularity: Granularity; }

function Axes({ width, yTicks, y, labels }: {
  width: number; yTicks: { v: number; text: string }[]; y: (v: number) => number;
  labels: { x: number; text: string }[];
}) {
  return (
    <g className="axes" aria-hidden="true">
      {yTicks.map((t) => (
        <g key={t.v}>
          <line x1={PAD.l} x2={width - PAD.r} y1={y(t.v)} y2={y(t.v)} className="grid" />
          <text x={PAD.l - 6} y={y(t.v)} dy="0.32em" textAnchor="end">{t.text}</text>
        </g>
      ))}
      {labels.map((l, i) => (
        <text key={i} x={l.x} y={HEIGHT - 8} textAnchor="middle">{l.text}</text>
      ))}
    </g>
  );
}

function BarChart({ buckets, granularity }: ChartProps) {
  const [ref, width] = useWidth(600);
  const max = Math.max(1, ...buckets.map((b) => b.analyses));
  const plotW = width - PAD.l - PAD.r, plotH = HEIGHT - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, buckets.length);
  const barW = Math.max(2, Math.min(36, slot - 2));
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const show = labelIndices(buckets.length, width);
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max];

  return (
    <div ref={ref} className="analytics-svg">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img"
        aria-label={`Bar chart of saved analyses per ${periodWord(granularity)}. Details are in the data table.`}>
        <Axes width={width} y={y} yTicks={ticks.map((v) => ({ v, text: String(v) }))}
          labels={buckets.flatMap((b, i) => (show.has(i) ? [{ x: PAD.l + slot * (i + 0.5), text: axisLabel(b, granularity) }] : []))} />
        {buckets.map((b, i) => {
          const x = PAD.l + slot * i + (slot - barW) / 2;
          return (
            <g key={b.key}>
              <title>{`${bucketLabel(b, granularity)}: ${b.analyses} saved ${b.analyses === 1 ? "analysis" : "analyses"}`}</title>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={plotH} fill="transparent" />
              {b.analyses > 0 && <path className="bar" d={barPath(x, y(b.analyses), barW, PAD.t + plotH - y(b.analyses))} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PercentChart({ buckets, granularity }: ChartProps) {
  const [ref, width] = useWidth(600);
  const plotW = width - PAD.l - PAD.r, plotH = HEIGHT - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, buckets.length);
  const cx = (i: number) => PAD.l + slot * (i + 0.5);
  const y = (v: number) => PAD.t + plotH - (v / 100) * plotH;
  const show = labelIndices(buckets.length, width);

  // Line segments only join consecutive periods that both have data; gaps stay gaps.
  const segments: string[] = [];
  let cur = "";
  buckets.forEach((b, i) => {
    if (b.flaggedPercent == null) { if (cur) segments.push(cur); cur = ""; return; }
    cur += `${cur ? "L" : "M"}${cx(i)},${y(b.flaggedPercent)}`;
  });
  if (cur) segments.push(cur);

  return (
    <div ref={ref} className="analytics-svg">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img"
        aria-label={`Line chart of the flagged share of windows per ${periodWord(granularity)}, from 0 to 100 percent. Details are in the data table.`}>
        <Axes width={width} y={y} yTicks={[0, 50, 100].map((v) => ({ v, text: `${v}%` }))}
          labels={buckets.flatMap((b, i) => (show.has(i) ? [{ x: cx(i), text: axisLabel(b, granularity) }] : []))} />
        {segments.map((d, i) => <path key={i} className="line" d={d} />)}
        {buckets.map((b, i) => b.flaggedPercent == null ? null : (
          <g key={b.key}>
            <title>{`${bucketLabel(b, granularity)}: ${b.flaggedPercent}% flagged (${b.flaggedWindows} of ${b.windows} windows)`}</title>
            <circle cx={cx(i)} cy={y(b.flaggedPercent)} r={Math.max(10, Math.min(slot / 2, 14))} fill="transparent" />
            <circle className="dot" cx={cx(i)} cy={y(b.flaggedPercent)} r={4} />
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---- container ----

interface PanelProps {
  /** True while the Analytics tab is shown; data loads the first time it becomes active. */
  active: boolean;
  /** Bumped by the app when History changes (save/delete), so the next view reloads. */
  version: number;
}

export function AnalyticsPanel({ active, version }: PanelProps) {
  const [state, setState] = useState<AnalyticsState>({ kind: "loading" });
  const loaded = useRef<number | null>(null);
  const seq = useRef(0);

  function load() {
    const my = ++seq.current;
    loaded.current = version;
    setState({ kind: "loading" });
    loadAnalytics().then(
      (data) => { if (my === seq.current) setState({ kind: "ready", analytics: computeAnalytics(data) }); },
      (e) => { if (my === seq.current) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }); },
    );
  }

  useEffect(() => {
    if (active && loaded.current !== version) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, version]);

  return <AnalyticsView state={state} onRetry={load} />;
}
