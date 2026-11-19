import { useId } from "react";
import { FATIGUE_LABEL, groupWorkers, type Fatigue, type ReviewClip, type ReviewEntry, type ReviewPlan } from "../review";
import { EXERTION_LABEL, newId, type Exertion } from "../schedule";

// Shift review: what the user tells us about each analysed clip. Page memory only.

interface Props {
  clips: ReviewClip[];
  entries: ReviewEntry[];
  onEntries: (fn: (e: ReviewEntry[]) => ReviewEntry[]) => void;
  confirmed: ReadonlySet<string>;
  onConfirm: (signature: string, ok: boolean) => void;
  basis: string;                       // worker key, or "" for the general template
  onBasis: (key: string) => void;
  plan: ReviewPlan | null;             // for the selected worker
  onFill: () => void;
  onRemoveClip: (id: string) => void;
}

export const emptyEntry = (clip: ReviewClip): ReviewEntry => ({
  id: newId("r"), clipId: clip.id, trackKey: (clip.tracks.find((t) => t.scored) ?? clip.tracks[0])?.key ?? "single",
  worker: "", task: "", timeInShift: "", minutes: null, exertion: "", fatigue: "",
});

export function ShiftReview({ clips, entries, onEntries, confirmed, onConfirm, basis, onBasis, plan, onFill, onRemoveClip }: Props) {
  const uid = useId();
  const groups = groupWorkers(entries);
  const set = (id: string, patch: Partial<ReviewEntry>) => onEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const group = groups.find((g) => g.key === basis) ?? null;

  return (
    <section className="card review" aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`}>Shift review <span className="muted review-optional">(optional)</span></h3>
      <p className="muted">
        Add analysed clips from the Analysis tab, then tell the planner what each one shows: the worker, the task, roughly when and for how long,
        and the worker’s own ratings of how hard it felt. These ratings and your task details drive the next-day draft. Movement-deviation
        results are shown only as context. They don’t measure fatigue or workload and aren’t used to set tasks or breaks. Nothing here is saved.
      </p>

      {clips.length === 0 && (
        <p className="review-empty">No clips yet. After an analysis, use <strong>Add to shift review</strong> under the results.</p>
      )}

      {clips.map((clip) => {
        const mine = entries.filter((e) => e.clipId === clip.id);
        return (
          <div key={clip.id} className="review-clip">
            <div className="review-clip-head">
              <div>
                <strong>{clip.name}</strong>
                <span className="muted"> · {clip.durationS != null ? `${clip.durationS.toFixed(1)} s` : "duration not stored"} · {
                  clip.source === "multi" ? `${clip.tracks.length} tracked ${clip.tracks.length === 1 ? "person" : "people"}` : clip.source === "saved" ? "saved analysis" : "single-person analysis"}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={`Remove ${clip.name} from the shift review`} onClick={() => onRemoveClip(clip.id)}>✕</button>
            </div>
            {mine.map((e, i) => {
              const tr = clip.tracks.find((t) => t.key === e.trackKey);
              return (
                <fieldset key={e.id} className="review-entry">
                  <legend className="sr-only">{clip.name}, person {i + 1}</legend>
                  <div className="review-grid">
                    <label className="field"><span>Person / track</span>
                      <select value={e.trackKey} onChange={(ev) => set(e.id, { trackKey: ev.target.value })} disabled={clip.tracks.length < 2}>
                        {clip.tracks.map((t) => <option key={t.key} value={t.key}>{t.label}{t.scored ? "" : " (not scored)"}</option>)}
                      </select>
                    </label>
                    <label className="field"><span>Worker</span>
                      <input type="text" value={e.worker} placeholder="e.g. Worker 1" list={`${uid}-workers`} onChange={(ev) => set(e.id, { worker: ev.target.value })} />
                    </label>
                    <label className="field grow"><span>Task in this clip</span>
                      <input type="text" value={e.task} placeholder="e.g. Rebar tying" onChange={(ev) => set(e.id, { task: ev.target.value })} />
                    </label>
                    <label className="field"><span>Time in shift</span>
                      <input type="time" value={e.timeInShift} onChange={(ev) => set(e.id, { timeInShift: ev.target.value })} />
                    </label>
                    <label className="field"><span>Time on this task (min)</span>
                      <input type="number" inputMode="numeric" min={5} max={720} step={5} value={e.minutes ?? ""}
                        onChange={(ev) => set(e.id, { minutes: ev.target.value === "" ? null : Math.max(0, Number(ev.target.value) || 0) })} />
                    </label>
                    <label className="field"><span>Exertion (worker’s own rating)</span>
                      <select value={e.exertion} onChange={(ev) => set(e.id, { exertion: ev.target.value as Exertion | "" })}>
                        <option value="">Not reported</option>
                        {(Object.keys(EXERTION_LABEL) as Exertion[]).map((k) => <option key={k} value={k}>{EXERTION_LABEL[k]}</option>)}
                      </select>
                    </label>
                    <label className="field"><span>Tiredness (worker’s own rating)</span>
                      <select value={e.fatigue} onChange={(ev) => set(e.id, { fatigue: ev.target.value as Fatigue | "" })}>
                        <option value="">Not reported</option>
                        {(Object.keys(FATIGUE_LABEL) as Fatigue[]).map((k) => <option key={k} value={k}>{FATIGUE_LABEL[k]}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="review-entry-foot">
                    <p className="muted context-line">
                      <span className="tag">Context only</span>{" "}
                      {tr?.scored ? `Movement deviation: ${tr.aboveTrained} of ${tr.windows} scored windows above the trained threshold. Not a fatigue or workload measure.`
                        : "This person wasn’t scored (not enough continuous tracking)."}
                    </p>
                    {mine.length > 1 && (
                      <button type="button" onClick={() => onEntries((es) => es.filter((x) => x.id !== e.id))}>Remove this person</button>
                    )}
                  </div>
                </fieldset>
              );
            })}
            {clip.tracks.length > 1 && (
              <button type="button" onClick={() => onEntries((es) => [...es, { ...emptyEntry(clip), trackKey: clip.tracks.find((t) => !mine.some((m) => m.trackKey === t.key))?.key ?? clip.tracks[0].key }])}>
                + Another person from this video
              </button>
            )}
          </div>
        );
      })}
      <datalist id={`${uid}-workers`}>{groups.map((g) => <option key={g.key} value={g.name} />)}</datalist>

      {groups.some((g) => g.needsConfirmation) && (
        <fieldset className="review-confirm">
          <legend>Same person?</legend>
          <p className="muted">Track A in one video isn’t necessarily Track A in another, and two tracks in one video are usually two people. Confirm before clips are combined for one worker.</p>
          {groups.filter((g) => g.needsConfirmation).map((g) => (
            <label key={g.signature} className="check">
              <input type="checkbox" checked={confirmed.has(g.signature)} onChange={(ev) => onConfirm(g.signature, ev.target.checked)} />
              The {new Set(g.entries.map((e) => `${e.clipId}:${e.trackKey}`)).size} clips or tracks entered for {g.name} all show the same person
            </label>
          ))}
        </fieldset>
      )}

      {clips.length > 0 && (
        <div className="review-basis">
          <label className="field"><span>Base the next-day draft on</span>
            <select value={basis} onChange={(ev) => onBasis(ev.target.value)}>
              <option value="">General template (no shift review)</option>
              {groups.map((g) => <option key={g.key} value={g.key}>Shift review for {g.name}</option>)}
            </select>
          </label>
          {group && plan && (
            plan.personalized ? (
              <div className="review-status ok" role="status">
                <p><strong>Enough information for a draft based on the shift review.</strong></p>
                <ul>{plan.basis.map((b) => <li key={b}>{b}</li>)}</ul>
                {plan.gaps.length > 0 && <ul className="muted">{plan.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
                <button type="button" onClick={onFill}>Fill the tasks below from the review</button>
              </div>
            ) : (
              <div className="review-status missing" role="status">
                <p><strong>Not enough information to personalise yet.</strong> The draft will be a general schedule template. Missing:</p>
                <ul>{plan.missing.map((m) => <li key={m}>{m}</li>)}</ul>
                {plan.gaps.length > 0 && <ul className="muted">{plan.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}
