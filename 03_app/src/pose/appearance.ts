import type { Frame } from "./coco";

// Coarse clothing colour of one detected person, used only to tell fragments of different people
// apart when the tracker loses someone for a while (src/pose/tracks.ts). Computed in the browser
// from the frame already drawn for the pose model; it never leaves the browser, is not stored and is
// not used for scoring. It is not a re-identification model: two people in similar clothes look the
// same to it, so it can only veto a link, never prove one.
//
// Descriptor: median RGB (0..1) of sample points inside the torso (between shoulders and hips) and
// along the thighs (hip -> knee). null parts when those keypoints aren't visible.

export type Appearance = [number, number, number, number, number, number];   // torso RGB, thigh RGB (NaN = unknown)

const MIN_CONF = 0.2;
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function sample(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, pts: [number, number][]): [number, number, number] {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  for (const [x, y] of pts) {
    const px = Math.round(x - x0), py = Math.round(y - y0);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = (py * w + px) * 4;
    r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
  }
  return r.length >= 3 ? [med(r) / 255, med(g) / 255, med(b) / 255] : [NaN, NaN, NaN];
}

export function describeAppearance(ctx: CanvasRenderingContext2D, kp: Frame): Appearance | null {
  const ok = (k: number) => kp[k][2] >= MIN_CONF;
  const torso: [number, number][] = [], thigh: [number, number][] = [];
  if ([5, 6, 11, 12].every(ok)) {
    for (const u of [0.25, 0.4, 0.5, 0.6, 0.75]) for (const v of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const top = [kp[5][0] + (kp[6][0] - kp[5][0]) * u, kp[5][1] + (kp[6][1] - kp[5][1]) * u];
      const bot = [kp[11][0] + (kp[12][0] - kp[11][0]) * u, kp[11][1] + (kp[12][1] - kp[11][1]) * u];
      torso.push([top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v]);
    }
  }
  for (const [h, k] of [[11, 13], [12, 14]]) {
    if (!ok(h) || !ok(k)) continue;
    for (const v of [0.25, 0.4, 0.55, 0.7]) thigh.push([kp[h][0] + (kp[k][0] - kp[h][0]) * v, kp[h][1] + (kp[k][1] - kp[h][1]) * v]);
  }
  const all = [...torso, ...thigh];
  if (all.length < 3) return null;
  const x0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p[0])))), y0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p[1]))));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...all.map((p) => p[0]))) + 1), y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...all.map((p) => p[1]))) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const t = sample(img.data, img.width, img.height, x0, y0, torso), l = sample(img.data, img.width, img.height, x0, y0, thigh);
  return [...t, ...l] as Appearance;
}
