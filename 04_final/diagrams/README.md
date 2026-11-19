# Motion Atlas: final diagrams

Four 16:9 diagrams (1920 × 1080) for the final presentation. Each comes as an editable SVG and a 2× PNG (3840 × 2160).

| File | Shows |
| --- | --- |
| `system-architecture` | Browser, Worker, Render scoring API and D1, and what crosses each boundary |
| `supervisor-user-flow` | The site-lead story: sign in, analyze (single or multiple people), then History overview → flagged window → score and threshold → decision |
| `analysis-and-save-sequence` | Scoring request, then the separate automatic History save, with the saved and failed outcomes |
| `reopen-saved-analysis` | Loading History, opening one record (found / 404), and the optional local replay |

## Editing

The SVGs use inline attributes only, so they import into Figma, Inkscape, Illustrator and PowerPoint. To change several diagrams consistently, edit the source and rebuild:

- `src/lib.mjs`: design tokens (copied from `03_app/src/styles.css`), shapes, arrow styles and the shared legend
- `src/diagrams.mjs`: content and layout of each diagram

```powershell
# from the repository root; needs 03_app dependencies installed (npm install in 03_app) and Microsoft Edge
node 04_final/diagrams/src/build.mjs              # SVG + PNG
node 04_final/diagrams/src/build.mjs --svg-only
```

PNG export renders through playwright-core (an existing 03_app dev dependency) with the Inter and Mulish fonts in `src/fonts/` (SIL Open Font License, from Google Fonts). Without those fonts installed, an SVG opened on its own falls back to Segoe UI.

## Visual language

Colors, type (Mulish headings, Inter body) and radii come from the app's current dark theme. Glows are left out so the diagrams stay readable on a slide.

- Solid light arrow: request / data sent. Dashed grey: response. Orange: review path. Dashed amber: failure or fallback; dashed red: error (404).
- Orange left edge on a box: route that needs a logged-in session.
- Orange-tinted box: happens only in the browser (video and pose extraction).
- Sequence diagrams have a time axis on the far left; time runs downward.
- Times, scores and dates in the mock History rows and results panels are illustrative.

## Checked against the code

| Claim in the diagrams | Source |
| --- | --- |
| Analysis and History need a session; otherwise 401 “Please log in to use Motion Atlas.” | `03_app/worker/index.ts` |
| The user ID comes only from the verified session; the client sends no ID | `worker/index.ts`, `src/history.ts` |
| The video stays in the browser; MoveNet SinglePose / MultiPose Lightning at 25 fps, 17 COCO keypoints | `src/App.tsx`, `src/pose/movenet.ts`, `src/pose/coco.ts` |
| The Worker forwards keypoints to Render `POST /predict/keypoints` and returns the response unchanged | `worker/index.ts` |
| ONNX autoencoder; 48-frame (1.92 s) windows; returns scores, flags, start/end times and a posture summary | `02_model_server/app.py`, `src/pose/coco.ts` |
| The save is a separate `POST /api/history` (201); a failure shows “not saved” and **Try saving again**, and the results stay | `src/App.tsx`, `src/history.ts`, `worker/history.ts` |
| History: newest 20 listed, 100 kept per user, summary fields only; another user's record → 404 | `worker/history.ts` |
| Stored fields; no video, keypoints or file names | `migrations/0001_create_analysis_history.sql`, `worker/history.ts` |
| A saved analysis has no skeleton or quality checks; replay needs a local file and isn't uploaded; without one, play buttons are disabled | `src/App.tsx` |
| Multi-person: tracks A, B, C …, scored per track, uncertain identity shown as separate stretches, not saved to History | `src/components/MultiPersonAnalysis.tsx` |
| Score is movement deviation from reference data, not fatigue, workload, injury risk or safety | `MultiPersonAnalysis.tsx`, `App.tsx`, `02_model_server/app.py` |

### Mismatches found

1. ~~**The History panel text is out of date.**~~ Fixed: `src/components/HistoryPanel.tsx` now says History is saved to the user's account.
2. **The `browser_id` column name is out of date.** `analysis_history.browser_id` now holds the session user ID (as `worker/history.ts` and the README say). The migration comment still describes a browser ID. The diagrams say “Owner = session user ID.”
3. ~~**The login screen tagline says “Movement safety analysis.”**~~ Fixed: `src/AuthScreen.tsx` now reads “Movement deviation analysis.”
4. **Multi-person results never reach History,** so the site lead's History overview covers single-person analyses only. The flow diagram shows this. Multi-person clips can only go into the page-only Shift review (Schedule tab), which the diagrams leave out to stay focused.
5. **The app records no review decision.** The last step of the site-lead flow happens outside the app, and the diagram says so.
6. **The palette is dark.** The brief expected a light SaaS interface, but `styles.css` is a dark theme (“the app is always dark”). The diagrams follow the code.
