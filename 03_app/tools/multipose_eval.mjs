#!/usr/bin/env node
// EXPERIMENTAL multi-person evaluation on the validation clips (prototype_out/multipose_validation.md).
// 1) detect: SinglePose (reference) + MoveNet MultiPose with tracking at several input sizes/trackers,
//    on identical decoded frames, in headless Edge/Chrome (dist/ build, local static server).
// 2) tracks: the app's own track post-processing (src/pose/tracks.ts), rejoin on/off, writing each
//    scoreable segment's frames for tools/multipose_eval.py to score with the server's code.
// Everything stays on this machine. Outputs contain keypoints of real people: keep them out of Git.
//
//   npm run build
//   node tools/multipose_eval.mjs --frames <decoded frames dir> --out prototype_out/multipose_eval [--phase detect|tracks|all]
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildTracks, segmentFrames, segmentsToScore, trackSummary } from "../src/pose/tracks.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const FRAMES = resolve(args.frames);
const OUT = resolve(args.out ?? "prototype_out/multipose_eval");
const PHASE = args.phase ?? "all";
export const CONFIGS = [256, 320, 384, 512].flatMap((d) => ["boundingBox", "keypoint"].map((t) => ({ maxDimension: d, tracker: t })));
const cfgName = (c) => `${c.maxDimension}_${c.tracker}`;
const empty = () => Array.from({ length: 17 }, () => [0, 0, 0]);
await mkdir(join(OUT, "raw"), { recursive: true });
await mkdir(join(OUT, "tracks"), { recursive: true });
const clips = JSON.parse(await readFile(join(FRAMES, "clips.json"), "utf-8"));

if (PHASE === "detect" || PHASE === "all") {
  const DIST = resolve("dist/client");
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".json": "application/json" };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rel] = path.startsWith("/frames/") ? [FRAMES, path.slice(8)] : [DIST, path === "/" ? "index.html" : path.slice(1)];
    const file = resolve(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try { await stat(file); res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }); res.end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: args.channel ?? "msedge", headless: true, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
  // The app calls /api/history on load; the static server answers 404, which the app handles.
  await page.goto(base);
  await page.waitForFunction(() => window.__motionAtlas, null, { timeout: 120_000 });
  for (const clip of clips) {
    const manifest = JSON.parse(await readFile(join(FRAMES, clip, "manifest.json"), "utf-8"));
    const url = `${base}/frames/${encodeURIComponent(clip)}`;
    const single = await page.evaluate(([u, n]) => window.__motionAtlas.extractImages(u, n), [url, manifest.ticks]);
    const multi = {};
    for (const c of CONFIGS) {
      multi[cfgName(c)] = await page.evaluate(([u, n, s]) => window.__motionAtlas.extractImagesMulti(u, n, s), [url, manifest.ticks, c]);
    }
    await writeFile(join(OUT, "raw", `${clip}.json`), JSON.stringify({ clip, ticks: manifest.ticks, single: single.csv, multi }));
    console.log(`${clip}: ${manifest.ticks} ticks · ` + CONFIGS.map((c) => `${cfgName(c)} ${(multi[cfgName(c)].elapsedMs / 1000).toFixed(1)}s`).join(" · "));
  }
  await browser.close();
  server.close();
}

if (PHASE === "tracks" || PHASE === "all") {
  for (const clip of clips) {
    const raw = JSON.parse(await readFile(join(OUT, "raw", `${clip}.json`), "utf-8"));
    const out = { clip, ticks: raw.ticks, single: raw.single, configs: {} };
    for (const [name, m] of Object.entries(raw.multi)) {
      for (const relink of [true, false]) {
        const r = buildTracks(m.poses, { relink });
        out.configs[`${name}_${relink ? "relink" : "norelink"}`] = {
          maxPeople: r.maxPeople, brief: r.brief.length,
          tracks: r.tracks.map((t) => ({
            label: t.label, rawIds: t.rawIds, present: t.present, first: t.first, last: t.last, scoreable: t.scoreable,
            issues: t.issues, ...trackSummary(t),
            segments: t.segments.map((s) => ({
              ...s, frames: segmentsToScore(t).includes(s) ? segmentFrames(t, s, empty) : null,   // never a withheld segment
            })),
          })),
        };
      }
    }
    await writeFile(join(OUT, "tracks", `${clip}.json`), JSON.stringify(out));
    console.log(`tracks: ${clip}`);
  }
}
