
import { authClient } from "./auth-client";
import { AuthScreen } from "./AuthScreen";
import { Landing } from "./Landing";
import logo from "./assets/motion-atlas-logo-compact.png";
import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeKeypoints, wakeModelServer, type KeypointResult, type ScoredWindow } from "./api";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { HistoryPanel, type HistoryState } from "./components/HistoryPanel";
import { MultiPersonAnalysis } from "./components/MultiPersonAnalysis";
import { SchedulePlanner } from "./components/SchedulePlanner";
import { ScoreTimeline } from "./components/ScoreTimeline";
import { panelId, tabId, Tabs } from "./components/Tabs";
import { ThresholdControl } from "./components/ThresholdControl";
import { VideoPlayer, type VideoPlayerHandle } from "./components/VideoPlayer";
import { VideoRecorder } from "./components/VideoRecorder";
import {
  deleteHistory, HistoryError, listHistory, loadHistory, persistAnalysis, type HistoryItem, type SavedAnalysis,
} from "./history";
import { COCO_NAMES, FPS, WINDOW, framesToCsv } from "./pose/coco";
import { createDetector, EXTRACTOR, type Detector, type MultiSettings, type TrackerKind } from "./pose/movenet";
import { assessQuality, type Quality } from "./pose/quality";
import { extractVideo, type VideoExtraction } from "./pose/sampleVideo";
import { minRecordSeconds } from "./recording";
import type { ReviewClip } from "./review";
import { ModelEvaluation } from "./components/ModelEvaluation";
import { clampThreshold, classify, isTrained, sliderRange } from "./threshold";

// Video-first keypoint analysis. The video stays in this browser: MoveNet extracts one pose per
// frame here, and only the keypoints are sent to the Worker -> Render model API.

type Stage =
  | { kind: "idle" }
  | { kind: "extracting"; done: number; total: number }
  | { kind: "analyzing" }
  | { kind: "done" }
  | { kind: "error"; message: string };

// Saving to history is separate from the analysis: a failed save never hides the result.
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; id: string }
  | { kind: "failed"; message: string };

const WINDOW_S = WINDOW / FPS;
const MIN_RECORD_S = minRecordSeconds(WINDOW_S);
// Multi-person defaults, chosen on the 13 validation clips (prototype_out/multipose_eval).
const DEFAULT_MULTI: MultiSettings = { maxDimension: 256, tracker: "boundingBox" };
const HISTORY_LIMIT = 20;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function AppContent() {
  const [detector, setDetector] = useState<{ detector: Detector; backend: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [extraction, setExtraction] = useState<VideoExtraction | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [result, setResult] = useState<KeypointResult | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryState>({ kind: "loading" });
  const [restored, setRestored] = useState<SavedAnalysis | null>(null);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [playback, setPlayback] = useState<{ url: string; width: number; height: number } | null>(null);
  const player = useRef<VideoPlayerHandle>(null);
  const resultSection = useRef<HTMLElement>(null);
  const runSeq = useRef(0);
  const [recording, setRecording] = useState(false);
    const [tab, setTab] = useState<"analysis" | "schedule" | "analytics" | "model">("analysis");
  // Bumped whenever History changes, so the Analytics tab reloads the next time it's shown.
  const [historyVersion, setHistoryVersion] = useState(0);
  const [multiMode, setMultiMode] = useState(false);
    const [modelSeen, setModelSeen] = useState(false);
  useEffect(() => { if (tab === "model") setModelSeen(true); }, [tab]);
  const [multiSettings, setMultiSettings] = useState<MultiSettings>(DEFAULT_MULTI);
  const [multiFile, setMultiFile] = useState<File | null>(null);
  const [multiBusy, setMultiBusy] = useState(false);
  // Shift review for the Schedule tab: movement summaries only, page memory only (never History).
  const [reviewClips, setReviewClips] = useState<ReviewClip[]>([]);
  const addToReview = (clip: ReviewClip) => setReviewClips((cs) => (cs.some((c) => c.id === clip.id) ? cs : [...cs, clip]));
  const inReview = (id: string) => reviewClips.some((c) => c.id === id);
  const fileInput = useRef<HTMLInputElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { createDetector().then(setDetector, (e) => setLoadError(String(e))); }, []);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => () => { if (playback) URL.revokeObjectURL(playback.url); }, [playback]);
  useEffect(() => { refreshHistory(); }, []);
  useEffect(() => {
    if (restored) resultSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [restored]);

  const busy = stage.kind === "extracting" || stage.kind === "analyzing";

  function refreshHistory() {
    setHistory({ kind: "loading" });
    listHistory().then(
      (items) => setHistory({ kind: "ready", items }),
      (e) => setHistory({ kind: "error", message: errText(e) }),
    );
  }

  async function run(f: File) {
    if (!detector) return;

    if (multiMode) {   // separate analysis per tracked person; nothing saved to History
      wakeModelServer();
      setMultiFile(f);
      return;
    }

    wakeModelServer();
    runSeq.current += 1;
    setRestored(null); setPlayback(null); setSave({ kind: "idle" });
    setFile(f); setExtraction(null); setQuality(null); setResult(null);
    const url = URL.createObjectURL(f);
    setVideoUrl(url);
    let ex: VideoExtraction;

    try {
      setStage({ kind: "extracting", done: 0, total: 0 });
      ex = await extractVideo(url, detector.detector, (done, total) => setStage({ kind: "extracting", done, total }));
    } catch (e) {
      setStage({ kind: "error", message: `Could not read this video in the browser: ${String(e)}` });
      return;
    }

    setExtraction(ex);
    setQuality(assessQuality(ex.frames, ex.detection));
    await analyze(ex);
  }

  async function analyze(ex: VideoExtraction) {
    if (ex.frames.length < WINDOW) {
      setStage({ kind: "error", message: `The video is ${(ex.frames.length / FPS).toFixed(1)} s long; at least ${WINDOW_S.toFixed(2)} s is needed.` });
      return;
    }
    const seq = runSeq.current;
    setStage({ kind: "analyzing" });
    let r: KeypointResult;
    try {
      r = await analyzeKeypoints(ex.frames);
    } catch (e) {
      setStage({ kind: "error", message: errText(e) });
      return;
    }
    if (seq !== runSeq.current) return;
    setResult(r);
    setStage({ kind: "done" });
    setRestored(null);
    await saveResult(r, ex.frames.length / FPS);
  }

  /** Save the shown analysis to history. Only the summary and window scores/times are sent. */
  async function saveResult(r: KeypointResult, durationS: number) {
    const seq = runSeq.current;
    setSave({ kind: "saving" });
    const outcome = await persistAnalysis(r, durationS, WINDOW_S);
    if (outcome.saved) {
      setHistoryVersion((v) => v + 1);
      setHistory((h) => (h.kind === "ready"
        ? { kind: "ready", items: [outcome.item, ...h.items.filter((i) => i.id !== outcome.item.id)].slice(0, HISTORY_LIMIT) }
        : h));
      if (history.kind !== "ready") refreshHistory();
    }
    if (seq !== runSeq.current) return;
    setSave(outcome.saved ? { kind: "saved", id: outcome.item.id } : { kind: "failed", message: outcome.message });
  }

  function dropFromHistory(id: string) {
    setHistoryVersion((v) => v + 1);
    setHistory((h) => (h.kind === "ready" ? { kind: "ready", items: h.items.filter((i) => i.id !== id) } : h));
    setRestored((r) => (r?.item.id === id ? null : r));
    setSave((s) => (s.kind === "saved" && s.id === id ? { kind: "idle" } : s));
  }

  async function openSaved(item: HistoryItem) {
    setHistoryBusy(item.id); setHistoryError(null);
    try {
      const saved = await loadHistory(item.id);
      setMultiMode(false);
      setPlayback(null);
      setRestored(saved);
    } catch (e) {
      if (e instanceof HistoryError && e.status === 404) dropFromHistory(item.id);
      setHistoryError(`Could not open this saved analysis: ${errText(e)}`);
    } finally {
      setHistoryBusy(null);
    }
  }

  async function removeSaved(item: HistoryItem) {
    if (!window.confirm(`Delete the saved analysis from ${new Date(item.created_at).toLocaleString()}? This cannot be undone.`)) return;
    setHistoryBusy(item.id); setHistoryError(null);
    try {
      await deleteHistory(item.id);
      dropFromHistory(item.id);
    } catch (e) {
      if (e instanceof HistoryError && e.status === 404) dropFromHistory(item.id);
      else setHistoryError(`Could not delete this saved analysis: ${errText(e)}`);
    } finally {
      setHistoryBusy(null);
    }
  }

  /** Play a local copy of the video next to a saved analysis. It is not uploaded or re-analysed. */
  function openPlayback(f: File) {
    const url = URL.createObjectURL(f);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => setPlayback({ url, width: v.videoWidth || 16, height: v.videoHeight || 9 });
    v.onerror = () => { URL.revokeObjectURL(url); setHistoryError("This video could not be played in the browser."); };
    v.src = url;
  }

  // What the results section shows: a saved analysis, or the analysis of the video just chosen.
  const view: { result: KeypointResult; durationS: number | null; frameCount: number | null } | null = restored
    ? { result: restored.result, durationS: restored.item.duration_seconds, frameCount: null }
    : result && extraction
      ? { result, durationS: extraction.frames.length / FPS, frameCount: extraction.frames.length }
      : null;
  const canPlay = restored ? playback != null : videoUrl != null;

  // Exploratory threshold (display only): starts at the trained threshold for every result shown.
  const viewResult = view?.result ?? null;
  const [userThreshold, setUserThreshold] = useState<number | null>(null);
  useEffect(() => { setUserThreshold(null); }, [viewResult]);
  const trained = viewResult?.threshold ?? 0;
  const range = useMemo(
    () => sliderRange(viewResult?.windows.map((w) => w.reconstruction_score) ?? [], trained),
    [viewResult, trained],
  );
  const shownThreshold = userThreshold ?? trained;
  const custom = viewResult != null && !isTrained(shownThreshold, trained);
  const cls = useMemo(
    () => classify(viewResult?.windows ?? [], shownThreshold, trained),
    [viewResult, shownThreshold, trained],
  );
  const trainedCount = viewResult?.windows.filter((w) => w.above_threshold).length ?? 0;
  const flagged = viewResult?.windows.filter((_, i) => cls.flagged[i]) ?? [];
  const jump = (w: ScoredWindow) => { if (canPlay) player.current?.playFrom(w.start_seconds); };
  // This result as a shift-review clip: trained-threshold counts only, never the exploratory value.
  const reviewClip: ReviewClip | null = viewResult ? {
    id: restored ? `saved:${restored.item.id}` : `single:${file?.name}:${file?.size}:${file?.lastModified}`,
    name: restored ? `Saved analysis, ${new Date(restored.item.created_at).toLocaleString()}` : file?.name ?? "Video",
    durationS: view?.durationS ?? null,
    source: restored ? "saved" : "single",
    tracks: [{ key: "single", label: "Person (single-person analysis)", scored: true, windows: viewResult.windows.length, aboveTrained: trainedCount }],
  } : null;
  const activity = recording ? " · recording" : busy || multiBusy ? " · working" : "";

  return (
    <main>
      <header className="app-header">
        <div className="app-header-glow" aria-hidden="true" />
        <div className="brand">
          <h1><img className="brand-logo" src={logo} alt="Motion Atlas" width={1281} height={303} /></h1>
        </div>

        <button
          type="button"
          className="button-secondary"
          onClick={async () => {
            try {
              const result = await authClient.signOut();
              if (result.error) {
                window.alert(result.error.message ?? "Could not log out.");
                return;
              }
              window.location.reload();
            } catch {
              window.alert("Could not log out. Please try again.");
            }
          }}
        >
          Log out
        </button>

        <p className="app-tagline">
          {tab === "analysis"
            ? "Video movement analysis. Your video is processed in this browser and is never uploaded; only body keypoints are sent for scoring."
            : tab === "schedule"
              ? "Draft a shift plan with regular breaks. It stays on this page and isn’t saved or sent anywhere."
                            : tab === "analytics" ? "Summaries and trends from your own saved History. Movement deviations only, not fatigue, workload, injury risk or safety." : "How the movement model was evaluated: drag any 3D graph to orbit it."}
        </p>
                <Tabs label="Motion Atlas sections" selected={tab} onSelect={(id) => setTab(id as "analysis" | "schedule" | "analytics" | "model")}
                    tabs={[{ id: "analysis", label: <>Analysis{activity && <span className="tab-activity">{activity}</span>}</> }, { id: "schedule", label: "Schedule" }, { id: "analytics", label: "Analytics" }, { id: "model", label: "Model" }]} />
      </header>

      <div role="tabpanel" id={panelId("analysis")} aria-labelledby={tabId("analysis")} hidden={tab !== "analysis"}>

      <section className="picker">
        <button className="button" disabled={!detector || busy || multiBusy || recording} onClick={() => fileInput.current?.click()}>
          {detector ? "Choose a video" : "Loading pose model…"}
        </button>
        <input ref={fileInput} type="file" accept="video/*" disabled={!detector || busy || multiBusy || recording} hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) run(f); }} />
        <button ref={recordButton} className="button" disabled={!detector || busy || multiBusy || recording}
          aria-expanded={recording} onClick={() => setRecording(true)}>
          Record and analyze
        </button>
        {(multiMode ? multiFile : file) && <span className="muted">{(multiMode ? multiFile : file)!.name}</span>}
        <a href="#history">History</a>
        {loadError && <p className="error">The pose model could not be loaded: {loadError}</p>}
      </section>

      <section className="mode-switch" aria-label="Analysis mode">
        <button type="button" role="switch" aria-checked={multiMode} className="switch" disabled={busy || multiBusy || recording}
          onClick={() => setMultiMode((m) => !m)}>
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          <span className="switch-label">Analyze multiple people</span>
          <span className="switch-state" aria-hidden="true">{multiMode ? "On" : "Off"}</span>
        </button>
        <p className="muted switch-note">
          {multiMode ? "Each person gets a label (Track A, B, C …) that applies only within the current video. " : "When on, each person is analysed separately. "}
          Tracking can miss or switch people, especially when they’re small, partly hidden or close together.
        </p>
        {multiMode && (
          <div className="multi-settings">
            <label className="field narrow"><span>Detector input size</span>
              <select value={multiSettings.maxDimension} disabled={multiBusy}
                onChange={(e) => setMultiSettings((s) => ({ ...s, maxDimension: Number(e.target.value) }))}>
                {[256, 320, 384, 512].map((d) => <option key={d} value={d}>{d} px{d === DEFAULT_MULTI.maxDimension ? " (default)" : ""}</option>)}
              </select>
            </label>
            <label className="field narrow"><span>Tracker</span>
              <select value={multiSettings.tracker} disabled={multiBusy}
                onChange={(e) => setMultiSettings((s) => ({ ...s, tracker: e.target.value as TrackerKind }))}>
                <option value="boundingBox">Bounding box{DEFAULT_MULTI.tracker === "boundingBox" ? " (default)" : ""}</option>
                <option value="keypoint">Keypoint{DEFAULT_MULTI.tracker === "keypoint" ? " (default)" : ""}</option>
              </select>
            </label>
            <p className="muted field-note">
              Larger sizes can find smaller people but on our test clips also split one person into several tracks; no setting worked best on every clip.
              Changing a setting re-runs the current video.
            </p>
          </div>
        )}
      </section>

      {recording && (
        <VideoRecorder minSeconds={MIN_RECORD_S}
          onRecorded={(f) => { setRecording(false); run(f); }}
          onCancel={() => { setRecording(false); requestAnimationFrame(() => recordButton.current?.focus()); }} />
      )}

      {multiMode && multiFile && <MultiPersonAnalysis file={multiFile} settings={multiSettings} onBusy={setMultiBusy}
        onAddToReview={addToReview} inReview={inReview} />}

      <div hidden={multiMode}>
      {stage.kind === "extracting" && (
        <p role="status">Finding body keypoints… {stage.total ? `${stage.done} / ${stage.total} frames` : "opening video"}</p>
      )}
      {stage.kind === "analyzing" && (
        <p role="status">Scoring movement… The model server may need up to a minute to wake up.</p>
      )}
      {stage.kind === "error" && (
        <div className="error-box" role="alert">
          <p>{stage.message}</p>
          {extraction && <button onClick={() => analyze(extraction)}>Try the analysis again</button>}
        </div>
      )}

      {!restored && extraction && videoUrl && (
        <section className="limits" aria-label="Limitations">
          <p>
            <strong>One pose per frame.</strong> The analysis follows a single detected body. It does not reliably keep track of
            one person: if other people are in view, the analysed pose may switch between them. Check the skeleton on the video below.
          </p>
          {quality?.warnings.map((w) => <p key={w.id} className="warning">⚠ {w.text}</p>)}
        </section>
      )}

      {view && (
        <section aria-label="Result" ref={resultSection}>
          {restored && (
            <div className="saved-banner">
              <p>
                <strong>Saved analysis</strong> · {restored.item.label} · {new Date(restored.item.created_at).toLocaleString()}
                <br />
                <span className="muted">The video and keypoints were not stored, so the skeleton and quality checks aren’t available.</span>
              </p>
              <div className="saved-actions">
                <label className="button-secondary">
                  {playback ? "Open a different local video" : "Open the local video to play flagged moments"}
                  <input type="file" accept="video/*" hidden
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPlayback(f); }} />
                </label>
                <button onClick={() => { setRestored(null); setPlayback(null); }}>
                  {result ? "Back to current analysis" : "Close saved analysis"}
                </button>
              </div>
            </div>
          )}
          {reviewClip && (
            <div className="review-add">
              <button type="button" disabled={inReview(reviewClip.id)} onClick={() => addToReview(reviewClip)}>
                {inReview(reviewClip.id) ? "✓ In the shift review" : "Add to shift review"}
              </button>
              <span className="muted">For the Schedule tab. Keeps only this summary, on this page.</span>
            </div>
          )}
          {!restored && save.kind === "saving" && <p className="save-status muted" role="status">Saving to history…</p>}
          {!restored && save.kind === "saved" && <p className="save-status muted" role="status">✓ Saved to history.</p>}
          {!restored && save.kind === "failed" && (
            <div className="save-failed save-status" role="alert">
              <p>⚠ This analysis was <strong>not saved</strong> to history: {save.message} The results below are still complete; they’ll be lost when you leave the page.</p>
              {result && extraction && <button onClick={() => saveResult(result, extraction.frames.length / FPS)}>Try saving again</button>}
            </div>
          )}
          <div className="tiles">
            <div className={`tile tile-primary ${custom ? "is-custom" : ""}`}>
              <span className="tile-label">Windows above {custom ? "your threshold" : "threshold"}</span>
              <span className="tile-value">{cls.count} <span className="tile-of">of {view.result.windows.length}</span></span>
              <span className="muted">
                {cls.percent.toFixed(0)}% of scored {WINDOW_S.toFixed(2)} s windows
                {custom && ` · ${trainedCount} at the trained threshold`}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Trained threshold</span>
              <span className="tile-value">{trained.toFixed(3)}</span>
              <span className="muted">Set during model validation; fixed</span>
            </div>
            <div className="tile">
              <span className="tile-label">Video analysed</span>
              <span className="tile-value">{view.durationS != null ? `${view.durationS.toFixed(1)} s` : "—"}</span>
              <span className="muted">{view.frameCount != null ? `${view.frameCount} frames at ${FPS} fps` : "Saved summary; the video wasn’t stored"}</span>
            </div>
          </div>
          <p className="muted">
            {view.result.interpretation} At the trained threshold, “above threshold” means a window differs from the model’s reference
            movements (walking and pushing a cart) more than 90% of reference windows did.
          </p>

          <ScoreTimeline windows={view.result.windows} trainedThreshold={trained} threshold={shownThreshold}
            flagged={cls.flagged} durationS={view.durationS ?? 0} windowS={WINDOW_S} canPlay={canPlay} onSelect={jump} />

          <ThresholdControl value={shownThreshold} trained={trained} range={range} count={cls.count}
            total={view.result.windows.length} trainedCount={trainedCount}
            onChange={(v) => setUserThreshold(clampThreshold(v, range))} />

          {flagged.length === 0 && (
            <p className="moments-empty muted">No windows are above {custom ? "your" : "the trained"} threshold.</p>
          )}
          {flagged.length > 0 && (
            <div className="moments">
              <h2>Flagged moments{custom && <span className="pill pill-custom">your threshold</span>}</h2>
              {!canPlay && <p className="muted">Open your local copy of the video above to jump to these moments.</p>}
              <ul>
                {flagged.map((w) => (
                  <li key={w.window}>
                    <button disabled={!canPlay} onClick={() => jump(w)}>▶ {clock(w.start_seconds)}–{clock(w.end_seconds ?? w.start_seconds + WINDOW_S)}</button>
                    <span className="muted"> score {w.reconstruction_score.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {restored && playback && (
        <section aria-label="Video">
          <p className="muted">Local playback only: this video is not uploaded or re-analysed, so no skeleton is drawn.</p>
          <VideoPlayer ref={player} src={playback.url} frames={[]} width={playback.width} height={playback.height} showSkeleton={false} />
        </section>
      )}

      {!restored && extraction && videoUrl && (
        <section aria-label="Video">
          <label className="toggle">
            <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} /> Show the skeleton used for analysis
          </label>
          <VideoPlayer ref={player} src={videoUrl} frames={extraction.frames} width={extraction.width}
            height={extraction.height} showSkeleton={showSkeleton} />
        </section>
      )}

      {view && <Posture summary={view.result.posture_summary} />}

      {!restored && extraction && file && <Diagnostics extraction={extraction} quality={quality} backend={detector?.backend ?? "?"} fileName={file.name} />}

      </div>

      <HistoryPanel state={history} selectedId={restored?.item.id ?? null} busyId={historyBusy} actionError={historyError}
        onSelect={openSaved} onDelete={removeSaved} onRetry={refreshHistory} />
      </div>

      <div role="tabpanel" id={panelId("schedule")} aria-labelledby={tabId("schedule")} hidden={tab !== "schedule"}>
        <SchedulePlanner reviewClips={reviewClips} onRemoveClip={(id) => setReviewClips((cs) => cs.filter((c) => c.id !== id))} />
      </div>

      <div role="tabpanel" id={panelId("analytics")} aria-labelledby={tabId("analytics")} hidden={tab !== "analytics"}>
        <AnalyticsPanel active={tab === "analytics"} version={historyVersion} />
              </div>
      <div role="tabpanel" id={panelId("model")} aria-labelledby={tabId("model")} hidden={tab !== "model"}>
        {modelSeen && <ModelEvaluation />}
      </div>
    </main>
  );
}

function Posture({ summary }: { summary: KeypointResult["posture_summary"] }) {
  const num = (k: string) => (typeof summary[k] === "number" ? `${(summary[k] as number).toFixed(0)}` : "—");
  return (
    <section className="posture" aria-label="Posture">
      <h2>Approximate 2D posture</h2>
      <dl>
        <div><dt>Median trunk lean</dt><dd>{num("median trunk lean (degrees)")}°</dd></div>
        <div><dt>Median arm elevation</dt><dd>{num("median arm elevation (degrees)")}°</dd></div>
        <div><dt>Frames with shoulders and hips visible</dt><dd>{num("frames with shoulders/hips visible")}%</dd></div>
      </dl>
      <details>
        <summary>Experimental: knee bend (MoveNet estimate)</summary>
        <p>Median knee bend: {num("median knee bend (degrees)")}°</p>
        <p className="muted">
          Experimental. On our test clips MoveNet reported more knee bend than our YOLO extraction (about 5–6° more on median, up to 16°),
          and the pose detector behind the training data is unknown. Don’t compare this value with reference data or other detectors.
        </p>
      </details>
      <p className="muted">{String(summary.note ?? "")}</p>
    </section>
  );
}

function Diagnostics({ extraction: r, quality, backend, fileName }: { extraction: VideoExtraction; quality: Quality | null; backend: string; fileName: string }) {
  const conf = r.frames.flat().map((p) => p[2]);
  const min = (a: number[]) => a.reduce((m, v) => Math.min(m, v), Infinity);
  const max = (a: number[]) => a.reduce((m, v) => Math.max(m, v), -Infinity);
  function download() {
    const blob = new Blob([framesToCsv(r.frames, r.detection)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.[^.]+$/, "") + ".movenet.keypoints.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const rows: [string, string][] = [
    ["Extractor", `${EXTRACTOR} (${backend})`],
    ["Video (upright)", `${r.width} × ${r.height} px, ${r.durationS.toFixed(2)} s, source ≈ ${(1 / r.sourceFrameS).toFixed(1)} fps`],
    ["Samples", `${r.frames.length} at ${FPS} fps`],
    ["Point order", r.nameMismatches ? `${r.nameMismatches} frames not in COCO order` : `COCO-17 (${COCO_NAMES[0]} … ${COCO_NAMES[16]})`],
    ["Person found", quality ? `${(quality.personFound * 100).toFixed(1)}% of frames` : "—"],
    ["Legs detected", quality ? `${(quality.legsDetected * 100).toFixed(1)}% of frames with a person` : "—"],
    ["Confidence range", `${min(conf).toFixed(3)} – ${max(conf).toFixed(3)}`],
    ["Extraction time", `${(r.elapsedMs / 1000).toFixed(1)} s`],
  ];
  return (
    <details className="diagnostics">
      <summary>Diagnostics</summary>
      <table><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
      <button onClick={download}>Download keypoints CSV</button>
    </details>
  );
}

export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const [showLogin, setShowLogin] = useState(false);

  if (isPending) {
    return <p>Checking login...</p>;
  }

  if (!session) {
    return showLogin ? <AuthScreen onBack={() => setShowLogin(false)} /> : <Landing onLogin={() => setShowLogin(true)} />;
  }

  return <AppContent />;
}
