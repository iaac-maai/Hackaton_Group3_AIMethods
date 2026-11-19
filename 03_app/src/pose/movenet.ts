import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-converter";
import * as poseDetection from "@tensorflow-models/pose-detection";
import type { Appearance } from "./appearance";
import { COCO_NAMES, EMPTY_FRAME, type Frame } from "./coco";

export type Detector = poseDetection.PoseDetector;
export type DetectorInput = HTMLCanvasElement | ImageBitmap | HTMLImageElement;

export const EXTRACTOR = "movenet-singlepose-lightning-v4";

/**
 * MoveNet SinglePose Lightning, weights from the model provider (tfhub.dev -> Kaggle).
 * Smoothing is off: YOLO has no temporal filter and the autoencoder should see raw motion.
 * The library still carries a crop region from frame to frame (MoveNet's own tracking);
 * call detector.reset() between clips. Poses scoring < 0.25 (library default) are dropped
 * and written as an empty frame, like the YOLO converter does when nobody is detected.
 */
export async function createDetector(): Promise<{ detector: Detector; backend: string }> {
  await tf.setBackend("webgl").catch(() => false);
  await tf.ready();
  const detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    enableSmoothing: false,
  });
  return { detector, backend: tf.getBackend() };
}

export interface FrameResult {
  frame: Frame;
  detection: number;      // MoveNet pose score (0 when no pose)
  nameMismatch: boolean;  // keypoint names not in COCO_NAMES order
}

export async function detectFrame(detector: Detector, input: DetectorInput, timestampMs: number): Promise<FrameResult> {
  const poses = await detector.estimatePoses(input, undefined, timestampMs);
  if (!poses.length) return { frame: EMPTY_FRAME(), detection: 0, nameMismatch: false };
  const pose = poses[0];
  let nameMismatch = pose.keypoints.length !== COCO_NAMES.length;
  const frame: Frame = pose.keypoints.map((kp, i) => {
    if (kp.name !== COCO_NAMES[i]) nameMismatch = true;
    const score = Math.min(1, Math.max(0, kp.score ?? 0));
    return [kp.x, kp.y, score];
  });
  return { frame, detection: pose.score ?? 0, nameMismatch };
}

// ---------------------------------------------------------------------------------------------
// EXPERIMENTAL multi-person mode: MoveNet MultiPose Lightning (up to 6 people) with the library's
// tracker, which gives each detected person an ID that persists across frames while it can.
// Not validated against the training data's detector; see prototype_out/multipose_validation.md.

export type TrackerKind = "boundingBox" | "keypoint";
export interface MultiSettings { maxDimension: number; tracker: TrackerKind }
export const MULTI_EXTRACTOR = "movenet-multipose-lightning-v1";

export async function createMultiDetector(s: MultiSettings): Promise<Detector> {
  await tf.setBackend("webgl").catch(() => false);
  await tf.ready();
  return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
    enableSmoothing: false,
    enableTracking: true,
    trackerType: s.tracker === "keypoint" ? poseDetection.TrackerType.Keypoint : poseDetection.TrackerType.BoundingBox,
    multiPoseMaxDimension: s.maxDimension,
  });
}

/** `app`: coarse clothing colour (src/pose/appearance.ts), added after detection; stays in the browser. */
export interface DetectedPose { id: number; score: number; kp: Frame; app?: Appearance | null }

export async function detectMulti(detector: Detector, input: DetectorInput, timestampMs: number): Promise<DetectedPose[]> {
  const poses = await detector.estimatePoses(input, undefined, timestampMs);
  return poses
    .filter((p) => p.keypoints.length === COCO_NAMES.length && p.keypoints.every((kp, i) => kp.name === COCO_NAMES[i]))
    .map((p) => ({
      id: p.id ?? -1,
      score: p.score ?? 0,
      kp: p.keypoints.map((kp) => [kp.x, kp.y, Math.min(1, Math.max(0, kp.score ?? 0))]) as Frame,
    }));
}
