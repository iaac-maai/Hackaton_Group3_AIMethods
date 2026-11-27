import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeKeypoints, ApiError } from "../api";
import { EMPTY_FRAME, FPS, WINDOW } from "../pose/coco";
import { createMultiDetector, MULTI_EXTRACTOR, type MultiSettings } from "../pose/movenet";
import { extractVideoMulti, type MultiExtraction } from "../pose/sampleVideo";
import {
  buildTracks, clockAt, describeIssues, NO_EDITS, presentTrack, reviewTracks, segKey, segmentFrames, segmentsToScore, trackTimes,
  withheldSegments, type SegScore, type Track, type TrackEdits, type TrackPresentation, type TrackScore,
} from "../pose/tracks";
import { clampThreshold, classify, isTrained, sliderRange } from "../threshold";
import { ScoreTimeline } from "./ScoreTimeline";
import { ThresholdControl } from "./ThresholdControl";
import { VideoPlayer, type OverlayTrack, type VideoPlayerHandle } from "./VideoPlayer";
import type { ReviewClip } from "../review";
import { IconAlert, IconCheckShield, IconClock, IconCpu, IconEye, IconFrame, IconTag, IconUsers } from "./ui/Icons";
import { InfoTip } from "./ui/InfoTip";
import { Ring } from "./ui/Ring";
import { ScoreBar } from "./ui/ScoreBar";
import { VisibilityStrip, WindowBlocks } from "./ui/TrackStrips";

// Multi-person mode. Every detected person gets a temporary label (Track A, B, C …)
// that only applies within this clip. Each track is scored separately, per continuous segment, with
// the unchanged model and trained threshold. Nothing here is saved to History.
// Where the tracker lost someone and the app joined the pieces, the identity is marked uncertain and
// the user can separate or merge tracks. Scores are cached per segment (one tracker ID's frames), so
// edits only change which segments make up a track, never a segment's score. Only segmentsToScore()
// is ever sent: a segment that may contain two people (unlocated identity switch) is withheld.
// Pieces joined only by an automatic uncertain link (a long gap, or a brief gap with a doubt or
// identity-switch warning) are never shown as one person's result: such a track is presented per
// identity stretch (presentTrack) until the user confirms or separates.

export const TRACK_COLORS = ["#00d0ff", "#ffb400", "#ff5cd6", "#7dff3a", "#ff7043", "#b39dff", "#40e0d0", "#ffe08a"];
const WINDOW_S = WINDOW / FPS;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

export function MultiPersonAnalysis({ file, settings, onBusy, onAddToReview, inReview }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<MultiExtraction | null>(null);
  const [edits, setEdits] = useState<TrackEdits>(NO_EDITS);
  const [segScores, setSegScores] = useState<Record<string, SegScore>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [stretchIdx, setStretchIdx] = useState<number | null>(null);   // chosen stretch; null = first scored one
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [userThreshold, setUserThreshold] = useState<number | null>(null);
  const [hoverWin, setHoverWin] = useState<number | null>(null);   // display only: links chart, window blocks and moment buttons
  const player = useRef<VideoPlayerHandle>(null);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    const live = () => id === runId.current;
    const url = URL.createObjectURL(file);
    setVideoUrl(url); setExtraction(null); setEdits(NO_EDITS); setSegScores({}); setSelected(null); setUserThreshold(null);
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
      setExtraction(ex);
      setSelected(tr.tracks.find((t) => t.scoreable)?.label ?? tr.tracks[0]?.label ?? null);
      await scoreSegments(tr.tracks, {}, live);
      if (live()) setStage({ kind: "done" });
    })().finally(() => { if (live()) onBusy(false); });
    return () => { runId.current++; URL.revokeObjectURL(url); onBusy(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, settings.maxDimension, settings.tracker]);

  /** Score every scoreable segment not yet in `known` (one request per segment, as before). An error stops that track. */
  async function scoreSegments(tracks: Track[], known: Record<string, SegScore>, live: () => boolean) {
    for (const t of tracks) {
      const segs = segmentsToScore(t).filter((s) => !known[segKey(s)] || known[segKey(s)].kind === "error");
      for (let i = 0; i < segs.length; i++) {
        if (!live()) return;
        setStage({ kind: "scoring", label: t.label, done: i, total: segs.length });
        let r: SegScore;
        try {
          r = { kind: "ok", result: await analyzeKeypoints(segmentFrames(t, segs[i], EMPTY_FRAME)) };
        } catch (e) {
          r = e instanceof ApiError && e.status === 422 ? { kind: "skipped" } : { kind: "error", message: errText(e) };
        }
        if (!live()) return;
        setSegScores((s) => ({ ...s, [segKey(segs[i])]: r }));
        if (r.kind === "error") break;
      }
    }
  }

  const tracked = useMemo(() => (extraction ? buildTracks(extraction.poses, {}, edits) : null), [extraction, edits]);
  const pres: Record<string, TrackPresentation> = useMemo(() => {
    const out: Record<string, TrackPresentation> = {};
    for (const t of tracked?.tracks ?? []) out[t.label] = presentTrack(t, segScores);
    return out;
  }, [tracked, segScores]);
  const anyScored = (p?: TrackPresentation) => p != null && (p.kind === "combined" ? p.score.kind === "scored" : p.stretches.some((x) => x.score.kind === "scored"));

  // After an edit, score any segment that is new to a track (normally none: edits don't change segments).
  const editRun = useRef(0);
  useEffect(() => {
    if (!tracked || stage.kind !== "done") return;
    const missing = tracked.tracks.some((t) => segmentsToScore(t).some((s) => !segScores[segKey(s)]));
    if (!missing) return;
    const id = runId.current, my = ++editRun.current;
    onBusy(true);
    scoreSegments(tracked.tracks, segScores, () => id === runId.current && my === editRun.current)
      .finally(() => { if (id === runId.current) { setStage({ kind: "done" }); onBusy(false); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked]);

  useEffect(() => {
    if (tracked && selected && !tracked.tracks.some((t) => t.label === selected)) setSelected(tracked.tracks[0]?.label ?? null);
  }, [tracked, selected]);

  const editsCount = edits.separate.length + edits.merge.length + (edits.confirm?.length ?? 0);
  const separateLink = (key: string) => setEdits((e) => ({ ...e, separate: [...e.separate.filter((k) => k !== key), key] }));
  const mergeTracks = (a: Track, b: Track) => setEdits((e) => ({ ...e, merge: [...e.merge, [a.parts[0], b.parts[0]]] }));
  const confirmLink = (key: string) => setEdits((e) => ({ ...e, confirm: [...(e.confirm ?? []).filter((k) => k !== key), key] }));
  const undoMerges = (t: Track) => {
    const ids = new Set<string>([...t.parts, ...t.rawIds.map(String), ...t.absorbed.map(String)]);
    const keys = new Set(t.links.map((l) => l.key));
    setEdits((e) => ({
      ...e, merge: e.merge.filter(([x, y]) => !(ids.has(String(x)) && ids.has(String(y)))),
      confirm: (e.confirm ?? []).filter((k) => !keys.has(k)),
    }));
  };

  const track: Track | null = tracked?.tracks.find((t) => t.label === selected) ?? null;
  const trackPres = selected ? pres[selected] : undefined;
  const stretchView = trackPres?.kind === "per-stretch"
    ? trackPres.stretches.find((x) => x.stretch.index === stretchIdx)
      ?? trackPres.stretches.find((x) => x.score.kind === "scored") ?? trackPres.stretches[0] : null;
  const score: TrackScore | undefined = trackPres?.kind === "combined" ? trackPres.score : stretchView?.score;
  const result = score?.kind === "scored" ? score.result : null;
  const colorOf = (label: string) => TRACK_COLORS[(tracked?.tracks.findIndex((t) => t.label === label) ?? 0) % TRACK_COLORS.length];

  useEffect(() => { setUserThreshold(null); setStretchIdx(null); }, [selected]);
  useEffect(() => { setUserThreshold(null); }, [stretchIdx]);
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
      <div className="note-panel mo-fade-up">
        <span className="note-panel-icon"><IconAlert /></span>
        <div>
          <ul className="chip-row" aria-label="Notes">
            <li className="chip-tag">Labels are per video</li>
            <li className="chip-tag">Check the overlay</li>
            <li className="chip-tag">Not saved to History</li>
          </ul>
          <details className="details-tag">
            <summary>Details</summary>
            <p className="multi-note-text">
              Track A, B, C … labels apply only within this video and don’t identify a worker. Tracking can miss or switch people, especially when
              they’re small, partly hidden or close together, so check the overlay. Each track is scored separately with the same model and
              trained threshold. These results aren’t saved to History.
            </p>
          </details>
        </div>
      </div>

      {stage.kind === "loading" && <p role="status">Loading the multi-person pose model…</p>}
      {stage.kind === "extracting" && <p role="status">Finding people… {stage.total ? `${stage.done} / ${stage.total} frames` : "opening video"}</p>}
      {stage.kind === "scoring" && <p role="status">Scoring Track {stage.label} (part {stage.done + 1} of {stage.total})… The model server may need up to a minute to wake up.</p>}
      {stage.kind === "error" && <div className="error-box" role="alert"><p>{stage.message}</p></div>}

      {tracked && extraction && (
        <>
          <ul className="chip-row run-summary" aria-label="Run summary">
            {tracked.tracks.length === 0
              ? <li className="chip-tag"><IconTag />No person was tracked long enough to label.</li>
              : <>
                  <li className="chip-tag"><IconTag />{tracked.tracks.length} track{tracked.tracks.length > 1 ? "s" : ""} labelled</li>
                  <li className="chip-tag"><IconUsers />up to {tracked.maxPeople} people detected in one frame</li>
                </>}
            {tracked.brief.length > 0 && <li className="chip-tag"><IconClock />{tracked.brief.length} brief detection{tracked.brief.length > 1 ? "s" : ""} (under 0.5 s) ignored</li>}
            <li className="chip-tag"><IconCpu />{MULTI_EXTRACTOR}</li>
            <li className="chip-tag"><IconFrame />{settings.maxDimension} px</li>
            <li className="chip-tag"><IconEye />{settings.tracker === "keypoint" ? "keypoint" : "bounding-box"} tracker</li>
          </ul>
          {editsCount > 0 && (
            <p className="muted">
              You changed the tracking ({editsCount} edit{editsCount > 1 ? "s" : ""}).{" "}
              <button type="button" className="button-secondary" disabled={busy} onClick={() => setEdits(NO_EDITS)}>Undo all tracking edits</button>
            </p>
          )}

          {stage.kind === "done" && settings.maxDimension < 512 && !tracked.tracks.some((t) => anyScored(pres[t.label])) && (
            <p className="note-warn" role="status">
              No one could be scored with the {settings.maxDimension} px detector. If the people are small or far away in the frame, try a
              larger detector input size above (384 or 512 px). On our test clips that found small workers, but it also split some people into several tracks.
            </p>
          )}
          {stage.kind === "done" && tracked.tracks.length > 0 && (() => {
            const clip: ReviewClip = {
              id: `multi:${file.name}:${file.size}:${file.lastModified}:${settings.maxDimension}:${settings.tracker}`
                + (editsCount ? `:edits:${edits.separate.join(",")}|${edits.merge.map((m) => m.join("+")).join(",")}|${(edits.confirm ?? []).join(",")}` : ""),
              name: file.name, durationS, source: "multi",
              // One entry per track, or per stretch where the identity across a long gap isn't confirmed.
              tracks: tracked.tracks.flatMap((t) => reviewTracks(t, pres[t.label])),
            };
            return (
              <div className="review-add">
                <button type="button" disabled={inReview(clip.id)} onClick={() => onAddToReview(clip)}>
                  {inReview(clip.id) ? "✓ In the shift review" : "Add to shift review"}
                </button>
                <InfoTip label="About adding to the shift review">
                  <p>For the Schedule tab. Keeps only each track’s summary, on this page; you choose the person there.</p>
                </InfoTip>
              </div>
            );
          })()}
          {tracked.tracks.length > 0 && (
            <div className="track-picker" role="group" aria-label="Choose a track">
              {tracked.tracks.map((t) => {
                const p = pres[t.label];
                const sc = p?.kind === "combined" ? p.score : undefined;
                const status = p?.kind === "per-stretch"
                  ? (p.stretches.some((x) => x.score.kind === "pending") && busy ? "Scoring…" : `identity not confirmed · results for ${p.stretches.length} stretches, not combined`)
                  : sc?.kind === "scored"
                  ? `${sc.result.windows_above_threshold} of ${sc.result.windows.length} windows above threshold`
                  : sc?.kind === "pending" ? (busy ? "Scoring…" : "Waiting")
                  : sc?.kind === "error" ? "Scoring failed"
                  : withheldSegments(t).length ? "Not scored: possible identity switch"
                  : "Not enough continuous tracking to score";
                return (
                  <button key={t.label} type="button" className={`track-chip ${t.label === selected ? "on" : ""} ${anyScored(p) ? "" : "muted-chip"}`}
                    aria-pressed={t.label === selected} onClick={() => setSelected(t.label)}>
                    <span className="track-swatch" style={{ background: colorOf(t.label) }} aria-hidden="true">{t.label}</span>
                    <span className="track-chip-text">
                      <strong>Track {t.label}{t.identity === "uncertain" && <span className="pill pill-uncertain">identity uncertain</span>}</strong>
                      <span>{trackTimes(t, tracked.frameCount).firstSeen}–{trackTimes(t, tracked.frameCount).lastSeen} · {Math.round((t.present / tracked.frameCount) * 100)}% of clip · {status}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {track && (
            <div className="track-detail track-card mo-fade-up">
              <div className="track-head">
                <span className="track-swatch" style={{ background: colorOf(track.label) }} aria-hidden="true">{track.label}</span>
                <h2>Track {track.label}</h2>
                <span className="chip-tag"><IconClock />{trackTimes(track, tracked.frameCount).firstSeen}–{trackTimes(track, tracked.frameCount).lastSeen}</span>
                {track.identity === "uncertain"
                  ? <span className="chip-tag warn"><IconAlert size={15} />identity uncertain</span>
                  : <span className="chip-tag ok"><IconCheckShield />identity consistent</span>}
              </div>
              <VisibilityStrip track={track} frameCount={tracked.frameCount} />
              <IdentityPanel track={track} tracks={tracked.tracks} frameCount={tracked.frameCount} disabled={busy}
                onPlay={(sec) => player.current?.playFrom(sec)} onSeparate={separateLink} onConfirm={confirmLink} onMerge={mergeTracks} onUndoMerge={undoMerges} />
              {trackPres?.kind === "per-stretch" && (
                <div className="stretches" role="group" aria-label={`Identity stretches of Track ${track.label}`}>
                  <p className="note-warn">
                    <strong>Identity not confirmed.</strong> Track {track.label} joins {trackPres.stretches.length} stretches where the tracker lost the
                    person and the join isn’t certain: a long gap, or a brief one where something doesn’t match or another person was close (see the
                    warnings below). They may be different people, so their results are shown separately and never combined.
                    If you know it’s one person, use “Confirm same person” above; if not, “Separate”.
                  </p>
                  {trackPres.stretches.map(({ stretch: st, score: sc }) => (
                    <button key={st.index} type="button" className={`button-secondary stretch-chip ${st.index === stretchView?.stretch.index ? "on" : ""}`}
                      aria-pressed={st.index === stretchView?.stretch.index} onClick={() => setStretchIdx(st.index)}>
                      Stretch {st.index} · {clockAt(st.start)}–{clockAt(st.end)} · {sc.kind === "scored"
                        ? `${sc.result.windows_above_threshold} of ${sc.result.windows.length} windows above threshold`
                        : sc.kind === "pending" ? "scoring…" : sc.kind === "error" ? "scoring failed" : "not scored"}
                    </button>
                  ))}
                </div>
              )}
              {trackPres?.kind === "combined" && trackPres.confirmedByUser && (
                <p className="muted">Includes pieces you joined or confirmed as one person; the result below combines them on your say-so.</p>
              )}
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
                    await scoreSegments([track], segScores, () => id === runId.current);
                    if (id === runId.current) { setStage({ kind: "done" }); onBusy(false); }
                  }}>Try again</button>
                </div>
              )}
              {result && (
                <>
                  {withheldSegments(track).length > 0 && (
                    <p className="note-warn" role="note">
                      Not scored, because the tracker may have switched people and a score could mix two of them:{" "}
                      {withheldSegments(track).map((x) => `${clockAt(x.start)}–${clockAt(x.end)}`).join(", ")}.
                    </p>
                  )}
                  {score?.kind === "scored" && score.skippedSegments > 0 && (
                    <p className="muted">{score.skippedSegments} tracked stretch{score.skippedSegments > 1 ? "es" : ""} had too few visible points and {score.skippedSegments > 1 ? "were" : "was"} not scored.</p>
                  )}
                  <WindowBlocks windows={result.windows} flagged={cls.flagged} durationS={durationS} windowS={WINDOW_S}
                    uncertain={track.uncertain.map((u) => ({ start: u.start / FPS, end: u.end / FPS }))}
                    hover={hoverWin} onHover={setHoverWin} canPlay={videoUrl != null}
                    onSelect={(w) => player.current?.playFrom(w.start_seconds)} />
                  <div className="tiles">
                    <div className={`tile tile-primary has-ring ${custom ? "is-custom" : ""}`}>
                      <Ring value={result.windows.length ? cls.count / result.windows.length : 0} />
                      <span className="tile-label">
                        {stretchView ? `Track ${track.label}, stretch ${stretchView.stretch.index} only` : `Track ${track.label}`}: windows above {custom ? "your threshold" : "threshold"}
                      </span>
                      <span className="tile-value">{cls.count} <span className="tile-of">of {result.windows.length}</span></span>
                      <span className="muted">{cls.percent.toFixed(0)}% of scored {WINDOW_S.toFixed(2)} s windows{custom && ` · ${trainedCount} at the trained threshold`}</span>
                    </div>
                    <div className="tile has-ring">
                      <Ring value={durationS > 0 ? (result.windows.length * WINDOW_S) / durationS : 0} />
                      <span className="tile-label">Tracked and scored</span>
                      <span className="tile-value">{(result.windows.length * WINDOW_S).toFixed(1)} s</span>
                      <span className="muted">of {durationS.toFixed(1)} s video · gaps are untracked or uncertain stretches</span>
                    </div>
                  </div>
                  <div className="score-meaning">
                    <ul className="chip-row" aria-label="What the scores mean">
                      <li className="chip-tag">Compared with walking and pushing a cart</li>
                      <li className="chip-tag">Not fatigue or workload</li>
                      <li className="chip-tag">Not an injury-risk rating</li>
                    </ul>
                    <details className="details-tag">
                      <summary>Details</summary>
                      <p>
                        Scores show how much this track’s movement differs from the model’s reference movements (walking and pushing a cart).
                        They don’t measure fatigue or workload, and they aren’t an injury-risk rating or a safety certification.
                      </p>
                    </details>
                  </div>
                  <ScoreTimeline windows={result.windows} trainedThreshold={trained} threshold={shown} flagged={cls.flagged}
                    durationS={durationS} windowS={WINDOW_S} canPlay={videoUrl != null} onSelect={(w) => player.current?.playFrom(w.start_seconds)}
                    linked={hoverWin} onHover={setHoverWin} />
                  <ThresholdControl value={shown} trained={trained} range={range} count={cls.count} total={result.windows.length}
                    trainedCount={trainedCount} onChange={(v) => setUserThreshold(clampThreshold(v, range))} />
                  {flagged.length === 0 ? <p className="moments-empty muted">No windows of Track {track.label} are above {custom ? "your" : "the trained"} threshold.</p> : (
                    <div className="moments">
                      <h2>Flagged moments · Track {track.label}{custom && <span className="pill pill-custom">your threshold</span>}</h2>
                      <ul>
                        {flagged.map((w) => (
                          <li key={w.window} className={hoverWin === w.window ? "linked" : undefined}
                            onMouseEnter={() => setHoverWin(w.window)} onMouseLeave={() => setHoverWin(null)}>
                            <button type="button" onClick={() => player.current?.playFrom(w.start_seconds)}>▶ {clock(w.start_seconds)}–{clock(w.end_seconds ?? w.start_seconds + WINDOW_S)}</button>
                            <ScoreBar score={w.reconstruction_score} windows={result.windows} />
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

/** First/last visible time, coverage, uncertain stretches, and merge/separate controls for one track. */
function IdentityPanel({ track, tracks, frameCount, disabled, onPlay, onSeparate, onConfirm, onMerge, onUndoMerge }: {
  track: Track; tracks: Track[]; frameCount: number; disabled: boolean;
  onPlay: (seconds: number) => void; onSeparate: (key: string) => void; onConfirm: (key: string) => void;
  onMerge: (a: Track, b: Track) => void; onUndoMerge: (t: Track) => void;
}) {
  const times = trackTimes(track, frameCount, FPS);
  const byLabel = (l: string) => tracks.find((t) => t.label === l);
  const suggested = [...new Set(track.issues.flatMap((i) => (i.kind === "possible-same" || i.kind === "duplicate" ? [i.of] : [])))]
    .map(byLabel).filter((t): t is Track => t != null);
  const others = tracks.filter((t) => t !== track && !suggested.includes(t));
  const [mergeWith, setMergeWith] = useState("");
  return (
    <div className="identity" aria-label={`Identity of Track ${track.label}`}>
      <p>
        <strong>Visible</strong> {times.firstSeen}–{times.lastSeen} · in {Math.round(times.coverage * 100)}% of the clip ·{" "}
        {track.identity === "uncertain"
          ? <span className="pill pill-uncertain">identity uncertain</span>
          : <span className="pill pill-trained">identity consistent</span>}
      </p>
      {track.uncertain.length > 0 && (
        <ul className="uncertain-list">
          {track.uncertain.map((u) => (
            <li key={`${u.start}-${u.reason}`}>
              <button type="button" onClick={() => onPlay(u.start / FPS)}>▶ {clock(u.start / FPS)}–{clock(u.end / FPS)}</button>
              <span className="muted"> {u.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="identity-actions">
        {track.links.filter((l) => l.confidence !== "manual").map((l) => (
          <button key={l.key} type="button" className="button-secondary" disabled={disabled} onClick={() => onSeparate(l.key)}
            title="Treat the part after this gap as a different person">
            Separate at {clock(l.frame / FPS)}
          </button>
        ))}
        {track.links.filter((l) => l.confidence === "uncertain").map((l) => (
          <button key={`c-${l.key}`} type="button" className="button-secondary" disabled={disabled} onClick={() => onConfirm(l.key)}
            title="Treat the pieces before and after this gap as one person, and combine their results">
            Confirm same person at {clock(l.frame / FPS)}
          </button>
        ))}
        {track.links.some((l) => l.confidence === "manual") && (
          <button type="button" className="button-secondary" disabled={disabled} onClick={() => onUndoMerge(track)}>Undo my merge or confirmation</button>
        )}
        {suggested.map((o) => (
          <button key={o.label} type="button" className="button-secondary" disabled={disabled} onClick={() => onMerge(track, o)}>
            Same person as Track {o.label}: merge
          </button>
        ))}
        {others.length > 0 && (
          <span className="merge-other">
            <select aria-label={`Merge Track ${track.label} with another track`} value={mergeWith} disabled={disabled}
              onChange={(e) => setMergeWith(e.target.value)}>
              <option value="">Merge with track…</option>
              {others.map((o) => <option key={o.label} value={o.label}>Track {o.label}</option>)}
            </select>
            <button type="button" className="button-secondary" disabled={disabled || !mergeWith}
              onClick={() => { const o = byLabel(mergeWith); if (o) onMerge(track, o); setMergeWith(""); }}>Merge</button>
          </span>
        )}
      </div>
    </div>
  );
}
