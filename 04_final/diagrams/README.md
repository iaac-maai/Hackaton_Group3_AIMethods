# Motion Atlas: final diagrams
## Use case
Motion Atlas helps a site supervisor review video windows where movement differs from the model’s reference. A flag is a prompt for human review, not a fatigue, injury-risk, or safety assessment.

## User stories
- **Site supervisor (shown in the supervisor user flow):** As a site supervisor, I want to review the video windows where a worker’s movement differs from the model’s reference, so I can decide what to look at more closely.
- **Construction worker being recorded (not yet supported in the app):** As a construction worker whose video is analyzed, I want to understand what is processed, what is stored, and who can view my results, so I can discuss flagged moments with my supervisor.

  The diagrams already answer the first two parts:
  - **Browser → Worker:** the video stays in the browser. The browser sends only the extracted keypoint JSON (per frame: x, y and confidence for 17 points), along with the session cookie from the team-password login.
  - **Worker → Render:** the Worker checks the session and the payload size, then forwards the same keypoint JSON to `POST /predict/keypoints`. It sends no cookie, user ID or account details. Render returns the window scores, flags and times.
  - **Worker → D1 (History):** a separate save stores summaries and window scores, not video, keypoints or file names. Render is not involved.

  History is shared: everyone who logs in with the team password can see, open and delete every saved record. The owner field holds the fixed value `shared-team`, not anyone's identity and not the worker in the video, and records hold no worker name or ID. The app has no consent step and no worker account or view, so sharing results with the worker happens outside the app.

## Live system
- App: https://motion-atlas.motion-atlas-team3.workers.dev/
- Model server: [https://construction-safety-model-api.onrender.com]
- Model artifacts: [https://huggingface.co/iaac-maai/hackathon-team3-movement-strain-ae]

## How a visitor gets in
The app's only sign-in is **one shared team password**, checked by the Worker (`03_app/worker/gate.ts`). The Worker runs before every request, so a visitor without a session gets a small login page and none of the app. A correct password sets a 12-hour session cookie (`Secure`, `HttpOnly`, `SameSite=Lax`). After that, the app, analysis, History and Analytics work; without the cookie, private API routes answer 401 "Please log in to use Motion Atlas." There are no individual accounts, no sign-up and no email codes. Details: [app README, Login](../../03_app/README.md#login-one-shared-team-password).

**Cloudflare Access, if still enabled.** Until 27 November 2026 the live hostname was also behind a Cloudflare Access application (a `302` to an email one-time-code login on `*.cloudflareaccess.com`, checked with `curl -i`). Access is set in the Cloudflare dashboard, not in this repository, so the code can't remove it. While it stays on, visitors pass its email code first and then the team password. The dashboard steps to remove it are in the [app README](../../03_app/README.md#cloudflare-access-dashboard-only).

## Shared team password (brief section 7.2)
The brief requires that "the shared password from Wednesday stays required for everyone." Motion Atlas now meets this directly. The password is the Worker secret `APP_PASSWORD` (set with `wrangler secret put`, never in Git), checked on the server, and required for the page and every private API route. The password and test details are given in the course hand-in, never in the repository.

## Model start-up and wake-up
- **Model download.** Render runs `02_model_server` with `HF_KEYPOINT_REPO` / `HF_IMU_REPO` set in its dashboard (`render.yaml` declares them with `sync: false`, so the values aren't in Git). The first time a model is loaded, `model_loader.py` calls `huggingface_hub.snapshot_download` to fetch `model.onnx`, `scaler.npz` and `config.json` from that repo, then caches them for the life of the process. Render's start-up health check (`healthCheckPath: /health`) is normally that first load. The live repo ID is not verifiable from the repository; the published model is linked above.
- **Wake-up call.** Render's free plan sleeps when idle. When the user picks a video, the app sends `GET /api/health` (`03_app/src/api.ts`, `wakeModelServer`) and ignores the reply. The Worker forwards it to Render `GET /health` without a session check, and `/health` loads both models. Pose extraction runs in the browser meanwhile, so the server is often awake by the time the keypoints are sent. `/api/health` is the one API route that works without the team password.

## Final diagrams
- [System architecture](system-architecture.svg)
- [Supervisor user flow](supervisor-user-flow.svg)
- [Analysis and save sequence](analysis-and-save-sequence.svg)
- [Reopen saved analysis](reopen-saved-analysis.svg)

## Reflection
- **What is clear:** We now understand the full path from video to review: pose keypoints are extracted in the browser, the model scores short windows, and the supervisor reviews the flagged moments. A flag means movement differs from the model’s reference; it does not tell us why.

- **What is still unclear:** We have not yet shown how well the model generalizes to different workers, camera angles, and real site conditions. We also need stronger evidence for multi-person identity tracking, where people can be missed or confused.

- **What we would do next:** We would test the system on a larger, more varied set of site videos with labelled people and review moments. We would compare pose extraction methods on the same clips, measure how often the model’s flags match human review, and improve tracking before relying on per-person results.

## Limitations
- The model flags movement that differs from its reference; it does not identify the cause or diagnose fatigue, injury risk, or safety.
- Multi-person tracking may miss people or confuse identities; check the tracks before interpreting them.
- History stores summaries and window scores for single-person analyses, not video or keypoints. Multi-person results are not saved to History.


## Visual language

Colors, type (Mulish headings, Inter body) and radii come from the app's current dark theme. Glows are left out so the diagrams stay readable on a slide.

- Solid light arrow: request / data sent. Dashed grey: response. Orange: review path. Dashed amber: failure or fallback; dashed red: error (404).
- Orange left edge on a box: route that needs a logged-in session.
- Orange-tinted box: happens only in the browser (video and pose extraction).
- Purple band (system architecture): the Worker's shared-password gate, which every browser request crosses before reaching the app or the private API.
- Sequence diagrams have a time axis on the far left; time runs downward.
- Times, scores and dates in the mock History rows and results panels are illustrative.

## Checked against the code

| Claim in the diagrams | Source |
| --- | --- |
| One shared password (`APP_PASSWORD` secret) is the only sign-in; the Worker runs first for every request; the session is a random token in a Secure, HttpOnly, SameSite=Lax cookie, hashed in D1 `app_session`, 12 h | `03_app/worker/gate.ts`, `worker/index.ts`, `wrangler.jsonc`, `migrations/0003_create_app_sessions.sql` |
| The app, analysis, History and Analytics need a session; otherwise the login page or 401 “Please log in to use Motion Atlas.” | `worker/index.ts` |
| History owner is the fixed `shared-team`, set by the Worker; the client sends no ID | `worker/history.ts`, `worker/index.ts`, `src/history.ts` |
| The video stays in the browser; MoveNet SinglePose / MultiPose Lightning at 25 fps, 17 COCO keypoints | `src/App.tsx`, `src/pose/movenet.ts`, `src/pose/coco.ts` |
| The Worker forwards keypoints to Render `POST /predict/keypoints` and returns the response unchanged | `worker/index.ts` |
| Wake-up: the app calls `GET /api/health` when a video is picked and ignores the reply; the Worker forwards it to Render `GET /health` with no session check | `src/api.ts`, `src/App.tsx`, `worker/index.ts` |
| The model server downloads its model files from Hugging Face with `snapshot_download` on the first load (Render's `/health` check at start-up), then caches them | `02_model_server/model_loader.py`, `app.py`, `render.yaml` |
| Not drawn: Cloudflare Access | Dashboard setting outside the code; to be removed in the dashboard (see the app README) |
| ONNX autoencoder; 48-frame (1.92 s) windows; returns scores, flags, start/end times and a posture summary | `02_model_server/app.py`, `src/pose/coco.ts` |
| The save is a separate `POST /api/history` (201); a failure shows “not saved” and **Try saving again**, and the results stay | `src/App.tsx`, `src/history.ts`, `worker/history.ts` |
| History: newest 20 listed, 100 kept in the shared History, summary fields only; a record outside it → 404 | `worker/history.ts` |
| Stored fields; no video, keypoints or file names | `migrations/0001_create_analysis_history.sql`, `worker/history.ts` |
| A saved analysis has no skeleton or quality checks; replay needs a local file and isn't uploaded; without one, play buttons are disabled | `src/App.tsx` |
| Multi-person: tracks A, B, C …, scored per track, uncertain identity shown as separate stretches, not saved to History | `src/components/MultiPersonAnalysis.tsx` |
| Score is movement deviation from reference data, not fatigue, workload, injury risk or safety | `MultiPersonAnalysis.tsx`, `App.tsx`, `02_model_server/app.py` |


