#!/usr/bin/env node
// Capture a multi-person regression fixture through the real app path: the video is sampled at
// 25 fps in headless Edge/Chrome by src/pose/sampleVideo.ts and run through MoveNet MultiPose with
// tracking (dist/ build), exactly as the Analysis tab does. Writes the raw per-frame detections
// (tracker IDs, keypoints and a 6-number clothing colour per pose; no pixels) so test/tracks.regression.test.mjs can replay them.
//
// Detection scores on small workers sit close to MoveNet's 0.25 cut-off, so decoding the same clip
// another way (e.g. JPEG frames) can change which frames have a detection. Use this tool, not
// decode_frames.py, when the goal is to reproduce what the app showed.
//
//   npm run build
//   node tools/capture_multi_fixture.mjs --video <clip.mp4> --out test/fixtures/<name>.json
//     [--size 256] [--tracker boundingBox|keypoint] [--channel msedge|chrome] [--note "..."]
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const DIST = resolve("dist/client");
const VIDEO = resolve(args.video);
const OUT = resolve(args.out);
const settings = { maxDimension: Number(args.size ?? 256), tracker: args.tracker ?? "boundingBox" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/clip") { res.writeHead(200, { "content-type": "video/mp4" }); res.end(await readFile(VIDEO)); return; }
  const file = resolve(DIST, path === "/" ? "index.html" : path.slice(1));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try { await stat(file); res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: args.channel ?? "msedge", headless: true, args: ["--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => window.__motionAtlas, null, { timeout: 120_000 });
  const r = await page.evaluate(([u, s]) => window.__motionAtlas.extractVideoUrlMulti(u, s), [`${base}/clip`, settings]);
  const round = (v, d) => Math.round(v * d) / d;
  const fixture = {
    source: basename(VIDEO), settings, width: r.width, height: r.height, durationS: r.durationS, note: args.note ?? "",
    // per frame: [trackerId, poseScore, [[x, y, p] x 17], appearance (torso RGB, thigh RGB; null = NaN) | null]
    frames: r.poses.map((ps) => ps.map((p) => [p.id, round(p.score, 1000), p.kp.map(([x, y, c]) => [round(x, 10), round(y, 10), round(c, 1000)]),
      p.app ? p.app.map((v) => (Number.isFinite(v) ? round(v, 1000) : null)) : null])),
  };
  await writeFile(OUT, JSON.stringify(fixture));
  const ids = new Map();
  r.poses.forEach((ps, t) => ps.forEach((p) => { const e = ids.get(p.id) ?? { n: 0, first: t, last: t }; e.n++; e.last = t; ids.set(p.id, e); }));
  console.log(`${fixture.source}: ${r.poses.length} frames, ${r.width}x${r.height}, ${(r.elapsedMs / 1000).toFixed(1)} s; tracker IDs: `
    + [...ids].map(([id, e]) => `${id} (${e.n} frames, ${e.first}-${e.last})`).join(", "));
} finally {
  await browser.close();
  server.close();
}
