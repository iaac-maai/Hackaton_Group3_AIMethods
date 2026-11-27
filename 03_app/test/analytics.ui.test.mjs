// Analytics tab UI states, rendered to HTML with React's server renderer: loading, error (with
// retry), empty, ready (summary, notices, charts with text alternatives, data table), the
// retention-limit warning, and the "not a safety measure" statement in every state.
// The .tsx view is bundled with esbuild (already installed with Vite) into node_modules/.cache,
// which is ignored by Git, so React resolves from the app's own node_modules.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, test } from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeAnalytics } from "../src/analytics.ts";
import { APP_DIR } from "./helpers.mjs";

let AnalyticsView;

before(async () => {
  const out = await build({
    entryPoints: [join(APP_DIR, "src/components/AnalyticsPanel.tsx")],
    bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", write: false, logLevel: "silent",
  });
  const dir = join(APP_DIR, "node_modules/.cache/analytics-ui-test");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "AnalyticsPanel.mjs");
  await writeFile(file, out.outputFiles[0].text);
  ({ AnalyticsView } = await import(pathToFileURL(file).href));
});

const render = (state) => renderToStaticMarkup(createElement(AnalyticsView, { state, onRetry: () => {} }));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

const at = (y, m, d) => new Date(y, m - 1, d, 12).toISOString();
const rec = (created_at, window_count, flagged_count) => ({
  created_at, analysis_type: "video", duration_seconds: 12.5, window_count, flagged_count,
  flagged_percent: Math.round((flagged_count / window_count) * 10000) / 100, model: "keypoint_autoencoder", threshold: 0.42,
});
const ready = (records, retention_limit = 100) => ({ kind: "ready", analytics: computeAnalytics({ records, retention_limit }) });

const DISCLAIMER = /not measures of fatigue, workload, injury risk or safety/;

describe("states", () => {
  test("loading: status message, busy, no charts", () => {
    const html = render({ kind: "loading" });
    assert.match(html, /role="status"[^>]*>Loading the team’s analytics…/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /<svg/);
    assert.match(text(html), DISCLAIMER);
  });

  test("error: alert with the message and a retry button", () => {
    const html = render({ kind: "error", message: "Please log in to use Motion Atlas." });
    assert.match(html, /role="alert"/);
    assert.match(text(html), /Could not load the analytics: Please log in to use Motion Atlas\./);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
    assert.doesNotMatch(html, /<svg/);
  });

  test("empty: explains how analyses get here", () => {
    const html = render(ready([]));
    assert.match(text(html), /No saved analyses yet\. Run a single-person video analysis/);
    assert.doesNotMatch(html, /<svg/);
    assert.match(text(html), DISCLAIMER);
  });

  test("ready: summary, tiles, two charts with text alternatives, data table, type note", () => {
    const html = render(ready([rec(at(2026, 11, 1), 10, 2), rec(at(2026, 11, 3), 10, 0), rec(at(2026, 11, 3), 20, 5)]));
    const t = text(html);
    assert.match(t, DISCLAIMER);
    assert.match(t, /3 saved analyses between/);
    assert.match(t, /Saved analyses 3/);
    assert.match(t, /Flagged windows 7 \(17\.5%\)/);
    assert.equal((html.match(/<svg[^>]*role="img"/g) ?? []).length, 2);
    assert.match(html, /aria-label="Bar chart of saved analyses per day\./);
    assert.match(html, /aria-label="Line chart of the flagged share of windows per day/);
    assert.match(html, /<title>[^<]*: 2 saved analyses<\/title>/);
    assert.match(html, /<title>[^<]*: 20% flagged \(2 of 10 windows\)<\/title>/);
    assert.match(t, /Show the data as a table/);
    assert.equal((html.match(/<th scope="row">/g) ?? []).length, 3, "one row per day, including the empty day");
    assert.match(t, /— /, "the empty day shows no flagged share");
    assert.match(t, /All 3 saved analyses are video analyses\. Video is the only type/);
    assert.match(t, /Multi-person results aren’t saved to History, so they aren’t included\./);
    assert.match(t, /The shared History keeps the newest 100 analyses/);
    assert.doesNotMatch(t, /has reached its limit/);
  });

  test("at the retention limit: visible warning that totals aren't lifetime", () => {
    const html = render(ready([rec(at(2026, 11, 1), 10, 2), rec(at(2026, 11, 2), 10, 2)], 2));
    assert.match(text(html), /The shared History has reached its limit of 2 saved analyses\..*not lifetime totals/);
  });
});
