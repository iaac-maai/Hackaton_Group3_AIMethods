import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeKeypoints, ApiError, type KeypointResult, type ScoredWindow } from "../api";
import { EMPTY_FRAME, FPS, WINDOW } from "../pose/coco";
import { createMultiDetector, MULTI_EXTRACTOR, type MultiSettings } from "../pose/movenet";
import { extractVideoMulti, type MultiExtraction } from "../pose/sampleVideo";
import { buildTracks, describeIssues, segmentFrames, trackSummary, type Track, type TrackResult } from "../pose/tracks";
import { clampThreshold, classify, isTrained, sliderRange } from "../threshold";
import { ScoreTimeline } from "./ScoreTimeline";
import { ThresholdControl } from "./ThresholdControl";
import { VideoPlayer, type OverlayTrack, type VideoPlayerHandle } from "./VideoPlayer";
import type { ReviewClip } from "../review";

// Multi-person mode. Every detected person gets a temporary label (Track A, B, C …)
// that only applies within this clip. Each track is scored separately, per continuous segment, with
// the unchanged model and trained threshold. Nothing here is saved to History.

export const TRACK_COLORS = ["#00d0ff", "#ffb400", "#ff5cd6", "#7dff3a", "#ff7043", "#b39dff", "#40e0d0", "#ffe08a"];
const WINDOW_S = WINDOW / FPS;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type TrackScore =
  | { kind: "pending" }
  | { kind: "not-scoreable"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "scored"; result: KeypointResult; skippedSegments: number };

type Stage =
  | { kind: "loading" }
  | { kind: "extracting"; done: number; total: number }
  | { kind: "scoring"; label: string; done: number; total: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

interface Props {
  file: File;
  settings: MultiSettings;
  onBusy: (busy: boolean) => void;
  onAddToReview: (clip: ReviewClip) => void;
  inReview: (id: string) => boolean;
}

/** Merge one track's per-segment results onto the clip timeline (times are offset by the segment start). */
function mergeSegments(parts: { start: number; result: KeypointResult }[]): KeypointResult {
  const windows: ScoredWindow[] = parts
    .flatMap(({ start, result }) => result.windows.map((w) => ({
      ...w,
      start_sample: w.start_sample + start,
      start_seconds: Math.round((w.start_seconds + start / FPS) * 1000) / 1000,
      end_seconds: Math.round(((w.end_seconds ?? w.start_seconds + WINDOW_S) + start / FPS) * 1000) / 1000,
    })))
    .sort((a, b) => a.start_seconds - b.start_seconds)
    .map((w, i) => ({ ...w, window: i + 1 }));
  const above = windows.filter((w) => w.above_threshold).length;
  const first = parts[0].result;
  return {
    model: first.model, threshold: first.threshold, interpretation: first.interpretation, posture_summary: {},
    windows, windows_analyzed: windows.length, windows_above_threshold: above,
    percentage_above_threshold: windows.length ? (above / windows.length) * 100 : 0,
  };
}

export function MultiPersonAnalysis({ file, settings, onBusy, onAddToReview, inReview }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<MultiExtraction | null>(null);
  const [tracked, setTracked] = useState<TrackResult | null>(null);
  const [scores, setScores] = useState<Record<string, TrackScore>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [userThreshold, setUserThreshold] = useState<number | null>(null);
  const player = useRef<VideoPlayerHandle>(null);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    const live = () => id === runId.current;
    const url = URL.createObjectURL(file);
    setVideoUrl(url); setExtraction(null); setTracked(null); setScores({}); setSelected(null); setUserThreshold(null);
    onBusy(true);
    (async () => {
      let ex: MultiExtraction;
      try {
        setStage({ kind: "loading" });
        const detector = await createMultiDetector(settings);
        try {
          setStage({ kind: "extracting", done: 0, total: 0 });
          ex = await extractVideoMulti(url, detector, (done, total) => { if (live()) setStage({ kind: "extracting", done, total }); });
        } finally {
          detector.dispose();
        }
      } catch (e) {
        if (live()) setStage({ kind: "error", message: `Could not read this video in the browser: ${errText(e)}` });
        return;
      }
      if (!live()) return;
      const tr = buildTracks(ex.poses);
      setExtraction(ex); setTracked(tr);
      setSelected(tr.tracks.find((t) => t.scoreable)?.label ?? tr.tracks[0]?.label ?? null);
      const initial: Record<string, TrackScore> = {};
      for (const t of tr.tracks) {
        const sum = trackSummary(t);
        initial[t.label] = t.scoreable ? { kind: "pending" } : {
          kind: "not-scoreable",
          reason: sum.duplicate ? "This looks like a second detection of another track, so it isn’t scored."
            : "Not enough continuous tracking to score: no stretch of at least "
              + `${WINDOW_S.toFixed(2)} s where this person was tracked without interruption and enough body points were visible.`,
        };
      }
      setScores(initial);
      await scoreTracks(tr, initial, live);
      if (live()) setStage({ kind: "done" });
    })().finally(() => { if (live()) onBusy(false); });
    return () => { runId.current++; URL.revokeObjectURL(url); onBusy(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, settings.maxDimension, settings.tracker]);

  async function scoreTracks(tr: TrackResult, current: Record<string, TrackScore>, live: () => boolean) {
    const todo = tr.tracks.filter((t) => current[t.label]?.kind === "pending" || current[t.label]?.kind === "error");
    for (const t of todo) {
      if (!live()) return;
      const segs = t.segments.filter((s) => s.scoreableWindows > 0);
      const parts: { start: number; result: KeypointResult }[] = [];
      let skipped = 0, failure: string | null = null;
      for (let i = 0; i < segs.length; i++) {
        if (!live()) return;
        setStage({ kind: "scoring", label: t.label, done: i, total: segs.length });
        try {
          parts.push({ start: segs[i].start, result: await analyzeKeypoints(segmentFrames(t, segs[i], EMPTY_FRAME)) });
        } catch (e) {
          if (e instanceof ApiError && e.status === 422) skipped++;
          else { failure = errText(e); break; }
        }
      }
      if (!live()) return;
      const next: TrackScore = failure ? { kind: "error", message: failure }
        : parts.length ? { kind: "scored", result: mergeSegments(parts), skippedSegments: skipped }
        : { kind: "not-scoreable", reason: "Not enough continuous tracking to score: the server found no window with enough visible body points." };
      setScores((s) => ({ ...s, [t.label]: next }));
    }
  }

  const track: Track | null = tracked?.tracks.find((t) => t.label === selected) ?? null;
  const score = selected ? scores[selected] : undefined;
  const result = score?.kind === "scored" ? score.result : null;
  const colorOf = (label: string) => TRACK_COLORS[(tracked?.tracks.findIndex((t) => t.label === label) ?? 0) % TRACK_COLORS.length];

  useEffect(() => { setUserThreshold(null); }, [selected]);
  const trained = result?.threshold ?? 0;
  const range = useMemo(() => sliderRange(result?.windows.map((w) => w.reconstruction_score) ?? [], trained), [result, trained]);
  const shown = userThreshold ?? trained;
  const cls = useMemo(() => classify(result?.windows ?? [], shown, trained), [result, shown, trained]);
  const custom = result != null && !isTrained(shown, trained);
  const flagged = result?.windows.filter((_, i) => cls.flagged[i]) ?? [];
  const trainedCount = result?.windows.filter((w) => w.above_threshold).length ?? 0;
  const durationS = extraction ? extraction.poses.length / FPS : 0;

  const overlay: OverlayTrack[] = useMemo(() => (tracked?.tracks ?? []).map((t, i) => ({
    label: t.label, color: TRACK_COLORS[i % TRACK_COLORS.length], frames: t.frames, selected: t.label === selected,
  })), [tracked, selected]);

  const busy = stage.kind === "loading" || stage.kind === "extracting" || stage.kind === "scoring";

  return (
    <section className="multi" aria-label="Multiple-people analysis">
      <p className="multi-note">
        Track A, B, C … labels apply only within this video and don’t identify a worker. Tracking can miss or switch people, especially when
        they’re small, partly hidden or close together, so check the overlay. Each track is scored separately with the same model and
        trained threshold. These results aren’t saved to History.
      </p>

      {stage.kind === "loading" && <p role="status">Loading the multi-person pose model…</p>}
      {stage.kind === "extracting" && <p role="status">Finding people… {stage.total ? `${stage.done} / ${stage.total} frames` : "opening video"}</p>}
      {stage.kind === "scoring" && <p role="status">Scoring Track {stage.label} (part {stage.done + 1} of {stage.total})… The model server may need up to a minute to wake up.</p>}
      {stage.kind === "error" && <div className="error-box" role="alert"><p>{stage.message}</p></div>}

      {tracked && extraction && (
        <>
          <p className="muted">
            {tracked.tracks.length === 0 ? "No person was tracked long enough to label." :
              `${tracked.tracks.length} track${tracked.tracks.length > 1 ? "s" : ""} labelled · up to ${tracked.maxPeople} people detected in one frame`}
            {tracked.brief.length > 0 && ` · ${tracked.brief.length} brief detection${tracked.brief.length > 1 ? "s" : ""} (under 0.5 s) ignored`}
            {` · ${MULTI_EXTRACTOR}, ${settings.maxDimension} px, ${settings.tracker === "keypoint" ? "keypoint" : "bounding-box"} tracker`}
          </p>

          {stage.kind === "done" && settings.maxDimension < 512 && !tracked.tracks.some((t) => scores[t.label]?.kind === "scored") && (
            <p className="note-warn" role="status">
              No one could be scored with the {settings.maxDimension} px detector. If the people are small or far away in the frame, try a
              larger detector input size above (384 or 512 px). On our test clips that found small workers, but it also split some people into several tracks.
            </p>
          )}
          {stage.kind === "done" && tracked.tracks.length > 0 && (() => {
            const clip: ReviewClip = {
              id: `multi:${file.name}:${file.size}:${file.lastModified}:${settings.maxDimension}:${settings.tracker}`,
              name: file.name, durationS, source: "multi",
              tracks: tracked.tracks.map((t) => {
                const sc = scores[t.label];
                return sc?.kind === "scored"
                  ? { key: t.label, label: `Track ${t.label}`, scored: true, windows: sc.result.windows.length, aboveTrained: sc.result.windows_above_threshold }
                  : { key: t.label, label: `Track ${t.label}`, scored: false, windows: 0, aboveTrained: 0 };
              }),
            };
            return (
              <div className="review-add">
                <button type="button" disabled={inReview(clip.id)} onClick={() => onAddToReview(clip)}>
                  {inReview(clip.id) ? "✓ In the shift review" : "Add to shift review"}
                </button>
                <span className="muted">For the Schedule tab. Keeps only each track’s summary, on this page; you choose the person there.</span>
              </div>
            );
          })()}
          {tracked.tracks.length > 0 && (
            <div className="track-picker" role="group" aria-label="Choose a track">
              {tracked.tracks.map((t) => {
                const sc = scores[t.label];
                const status = sc?.kind === "scored"
                  ? `${sc.result.windows_above_threshold} of ${sc.result.windows.length} windows above threshold`
                  : sc?.kind === "pending" ? (busy ? "Scoring…" : "Waiting")
                  : sc?.kind === "error" ? "Scoring failed"
                  : "Not enough continuous tracking to score";
                return (
                  <button key={t.label} type="button" className={`track-chip ${t.label === selected ? "on" : ""} ${sc?.kind === "scored" ? "" : "muted-chip"}`}
                    aria-pressed={t.label === selected} onClick={() => setSelected(t.label)}>
                    <span className="track-swatch" style={{ background: colorOf(t.label) }} aria-hidden="true">{t.label}</span>
                    <span className="track-chip-text">
                      <strong>Track {t.label}</strong>
                      <span>{Math.round((t.present / tracked.frameCount) * 100)}% of clip · {status}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {track && (
            <div className="track-detail">
              <h2>Track {track.label}</h2>
              {describeIssues(track, tracked.frameCount).length > 0 && (
                <div className="track-warnings" role="note" aria-label={`Tracking warnings for Track ${track.label}`}>
                  <p><strong>Check the overlay:</strong></p>
                  <ul>{describeIssues(track, tracked.frameCount).map((w) => <li key={w}>⚠ {w}</li>)}</ul>
                </div>
              )}
              {score?.kind === "not-scoreable" && <p className="not-scored" role="status">{score.reason}</p>}
              {score?.kind === "error" && (
                <div className="error-box" role="alert">
                  <p>Track {track.label} couldn’t be scored: {score.message}</p>
                  <button type="button" disabled={busy} onClick={async () => {
                    if (!tracked) return;
                    const id = runId.current;
                    onBusy(true);
                    await scoreTracks(tracked, { [track.label]: score }, () => id === runId.current);
                    if (id === runId.current) { setStage({ kind: "done" }); onBusy(false); }
                  }}>Try again</button>
                </div>
              )}
              {result && (
                <>
                  {score?.kind === "scored" && score.skippedSegments > 0 && (
                    <p className="muted">{score.skippedSegments} tracked stretch{score.skippedSegments > 1 ? "es" : ""} had too few visible points and {score.skippedSegments > 1 ? "were" : "was"} not scored.</p>
                  )}
                  <div className="tiles">
                    <div className={`tile tile-primary ${custom ? "is-custom" : ""}`}>
                      <span className="tile-label">Track {track.label}: windows above {custom ? "your threshold" : "threshold"}</span>
                      <span className="tile-value">{cls.count} <span className="tile-of">of {result.windows.length}</span></span>
                      <span className="muted">{cls.percent.toFixed(0)}% of scored {WINDOW_S.toFixed(2)} s windows{custom && ` · ${trainedCount} at the trained threshold`}</span>
                    </div>
                    <div className="tile">
                      <span className="tile-label">Tracked and scored</span>
                      <span className="tile-value">{(result.windows.length * WINDOW_S).toFixed(1)} s</span>
                      <span className="muted">of {durationS.toFixed(1)} s video · gaps are untracked or uncertain stretches</span>
                    </div>
                  </div>
                  <p className="muted">
                    Scores show how much this track’s movement differs from the model’s reference movements (walking and pushing a cart).
                    They don’t measure fatigue or workload, and they aren’t an injury-risk rating or a safety certification.
                  </p>
                  <ScoreTimeline windows={result.windows} trainedThreshold={trained} threshold={shown} flagged={cls.flagged}
                    durationS={durationS} windowS={WINDOW_S} canPlay={videoUrl != null} onSelect={(w) => player.current?.playFrom(w.start_seconds)} />
                  <ThresholdControl value={shown} trained={trained} range={range} count={cls.count} total={result.windows.length}
                    trainedCount={trainedCount} onChange={(v) => setUserThreshold(clampThreshold(v, range))} />
                  {flagged.length === 0 ? <p className="moments-empty muted">No windows of Track {track.label} are above {custom ? "your" : "the trained"} threshold.</p> : (
                    <div className="moments">
                      <h2>Flagged moments · Track {track.label}{custom && <span className="pill pill-custom">your threshold</span>}</h2>
                      <ul>
                        {flagged.map((w) => (
                          <li key={w.window}>
                            <button type="button" onClick={() => player.current?.playFrom(w.start_seconds)}>▶ {clock(w.start_seconds)}–{clock(w.end_seconds ?? w.start_seconds + WINDOW_S)}</button>
                            <span className="muted"> score {w.reconstruction_score.toFixed(3)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {videoUrl && (
            <section aria-label="Video with tracks">
              <label className="toggle">
                <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} /> Show tracked skeletons
              </label>
              <p className="muted overlay-note">Each track has its own colour and letter. The selected track is drawn thicker. Check that the letter stays on the same person.</p>
              <VideoPlayer ref={player} src={videoUrl} frames={[]} width={extraction.width} height={extraction.height}
                showSkeleton={showSkeleton} tracks={overlay} />
            </section>
          )}
        </>
      )}
    </section>
  );
}
