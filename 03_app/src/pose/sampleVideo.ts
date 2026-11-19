import { describeAppearance } from "./appearance";
import { FPS, type Frame } from "./coco";
import { detectFrame, detectMulti, type DetectedPose, type Detector } from "./movenet";

export interface VideoExtraction {
  frames: Frame[];
  detection: number[];
  /** Presentation time (s) of the source frame actually analysed for each 25 fps sample. */
  mediaTimes: (number | null)[];
  width: number;
  height: number;
  durationS: number;
  sourceFrameS: number;      // estimated source frame duration
  nameMismatches: number;
  elapsedMs: number;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

const MEDIA_ERRORS = ["", "MEDIA_ERR_ABORTED", "MEDIA_ERR_NETWORK", "MEDIA_ERR_DECODE", "MEDIA_ERR_SRC_NOT_SUPPORTED"];

/** The browser's own reason a media element failed, e.g. "MEDIA_ERR_DECODE: …". */
export function mediaErrorDetail(video: HTMLMediaElement): string {
  const e = video.error;
  if (!e) return "unknown media error";
  return [MEDIA_ERRORS[e.code] ?? `code ${e.code}`, e.message].filter(Boolean).join(": ");
}

function once(video: HTMLMediaElement, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { video.removeEventListener("error", bad); resolve(); };
    const bad = () => {
      video.removeEventListener(type, ok);
      reject(new Error(`video error while waiting for ${type} (${mediaErrorDetail(video)})`));
    };
    video.addEventListener(type, ok, { once: true });
    video.addEventListener("error", bad, { once: true });
  });
}

/** Resolve with the presented frame's mediaTime, or null if no new frame shows up in time. */
function nextFrameTime(video: RVFCVideo, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (!video.requestVideoFrameCallback) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    video.requestVideoFrameCallback((_now, meta) => { clearTimeout(timer); resolve(meta.mediaTime); });
  });
}

async function seek(video: RVFCVideo, t: number): Promise<number | null> {
  const frameTime = nextFrameTime(video, 300);
  const seeked = once(video, "seeked");
  video.currentTime = t;
  await seeked;
  return frameTime;
}

/**
 * Browser recordings (MediaRecorder WebM in Chrome/Edge, sometimes Firefox) report duration as
 * Infinity until the end has been read. Seeking far past the end makes the browser scan the file
 * and publish the real duration; then return to the start. Files with a known duration are untouched.
 */
async function ensureFiniteDuration(video: HTMLVideoElement): Promise<void> {
  const known = () => Number.isFinite(video.duration) && video.duration > 0;
  if (known()) return;
  await new Promise<void>((resolve, reject) => {
    const events = ["durationchange", "timeupdate", "seeked"] as const;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      events.forEach((ev) => video.removeEventListener(ev, check));
      video.removeEventListener("error", bad);
      fn();
    };
    const check = () => { if (known()) done(resolve); };
    const bad = () => done(() => reject(new Error(`video error while finding the video length (${mediaErrorDetail(video)})`)));
    const timer = setTimeout(() => done(() => reject(new Error("could not determine the video length"))), 15000);
    events.forEach((ev) => video.addEventListener(ev, check));
    video.addEventListener("error", bad);
    video.currentTime = 1e101;
  });
  const back = once(video, "seeked");
  video.currentTime = 0;
  await back;
}

/** Estimate the source frame duration from frame presentation times during a short muted play. */
async function estimateFrameDuration(video: RVFCVideo): Promise<number> {
  const times: number[] = [];
  if (video.requestVideoFrameCallback) {
    const collect = (_n: number, meta: { mediaTime: number }) => {
      times.push(meta.mediaTime);
      if (times.length < 20) video.requestVideoFrameCallback!(collect);
    };
    video.requestVideoFrameCallback(collect);
    await video.play().catch(() => undefined);
    const deadline = performance.now() + 1500;
    while (times.length < 20 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    video.pause();
  }
  const diffs = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0.004).sort((a, b) => a - b);
  if (!diffs.length) return 1 / 30;
  const smallest = diffs[0];
  const cluster = diffs.filter((d) => d < smallest * 1.5);   // ignore skipped frames during playback
  return cluster[Math.floor(cluster.length / 2)];
}

interface SampledVideo {
  mediaTimes: (number | null)[];
  width: number;
  height: number;
  durationS: number;
  sourceFrameS: number;
  ticks: number;
}

/**
 * Sample a local video at 25 fps the way video_to_keypoints.py does: for output tick k take the
 * source frame nearest to k/25 s (seek to k/25 + half a source frame, which shows that frame), draw
 * it to a canvas and hand that canvas to `onFrame`. The video stays in the browser.
 */
async function sampleFrames(
  src: string,
  onFrame: (canvas: HTMLCanvasElement, k: number, timestampMs: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<SampledVideo> {
  const video = document.createElement("video") as RVFCVideo;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  await once(video, "loadeddata");
  await ensureFiniteDuration(video);
  const width = video.videoWidth;   // already upright: browsers apply the rotation tag
  const height = video.videoHeight;
  const durationS = video.duration;
  const frameS = await estimateFrameDuration(video);

  const ticks = Math.floor((durationS - frameS) * FPS + 1e-6) + 1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const mediaTimes: (number | null)[] = [];
  for (let k = 0; k < ticks; k++) {
    const target = Math.min(k / FPS + frameS / 2 - 1e-4, durationS - 1e-3);
    const shown = await seek(video, Math.max(0, target));   // null = no new frame (same frame still shown)
    ctx.drawImage(video, 0, 0, width, height);
    await onFrame(canvas, k, (k * 1000) / FPS);
    mediaTimes.push(shown);
    onProgress?.(k + 1, ticks);
  }
  video.removeAttribute("src");
  video.load();
  return { mediaTimes, width, height, durationS, sourceFrameS: frameS, ticks };
}

/** Single-person extraction (the default analysis): one pose per frame. */
export async function extractVideo(
  src: string,
  detector: Detector,
  onProgress?: (done: number, total: number) => void,
): Promise<VideoExtraction> {
  const t0 = performance.now();
  detector.reset();
  const frames: Frame[] = [];
  const detection: number[] = [];
  let nameMismatches = 0;
  const v = await sampleFrames(src, async (canvas, _k, ts) => {
    const r = await detectFrame(detector, canvas, ts);
    frames.push(r.frame);
    detection.push(r.detection);
    if (r.nameMismatch) nameMismatches++;
  }, onProgress);
  return {
    frames, detection, mediaTimes: v.mediaTimes, width: v.width, height: v.height, durationS: v.durationS,
    sourceFrameS: v.sourceFrameS, nameMismatches, elapsedMs: performance.now() - t0,
  };
}

export interface MultiExtraction {
  poses: DetectedPose[][];     // per frame, every detected person with its tracker ID
  mediaTimes: (number | null)[];
  width: number;
  height: number;
  durationS: number;
  sourceFrameS: number;
  elapsedMs: number;
}

/** Add each pose's coarse clothing colour (used only to keep fragments of different people apart). */
export function withAppearance(canvas: HTMLCanvasElement, poses: DetectedPose[]): DetectedPose[] {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return poses;
  return poses.map((p) => ({ ...p, app: describeAppearance(ctx, p.kp) }));
}

/** EXPERIMENTAL multi-person extraction: every detected person per frame, with tracker IDs. */
export async function extractVideoMulti(
  src: string,
  detector: Detector,
  onProgress?: (done: number, total: number) => void,
): Promise<MultiExtraction> {
  const t0 = performance.now();
  // No detector.reset() here: MoveNet MultiPose's reset() touches single-pose smoothing filters it
  // never created and throws. Pass a freshly created detector for each clip instead.
  const poses: DetectedPose[][] = [];
  const v = await sampleFrames(src, async (canvas, _k, ts) => {
    poses.push(withAppearance(canvas, await detectMulti(detector, canvas, ts)));
  }, onProgress);
  return {
    poses, mediaTimes: v.mediaTimes, width: v.width, height: v.height, durationS: v.durationS,
    sourceFrameS: v.sourceFrameS, elapsedMs: performance.now() - t0,
  };
}
