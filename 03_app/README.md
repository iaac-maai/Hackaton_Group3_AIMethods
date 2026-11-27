# Motion Atlas app

Video-first movement analysis. You pick a video and the browser extracts one body pose per frame with MoveNet SinglePose Lightning, at 25 fps. Only the keypoints are sent. They go to the Cloudflare Worker, which forwards them to the existing Render model API (`POST /predict/keypoints`). The page then shows:

- the per-window scores on a timeline;
- the flagged moments, using the start and end times returned by the API;
- the local video with the analysed skeleton drawn over it;
- the input-quality warnings.

**The raw video never leaves the browser.** IMU CSV analysis isn't in this app yet.

Diagrams of the system and the supervisor flow: [diagrams/README.md](diagrams/README.md).

## User stories

**Site supervisor (supported today).** As a site supervisor, I want to review the video windows where a worker's movement differs from the model's reference, so I can decide what to look at more closely. The supervisor logs in with the team password, analyses a clip, reviews the flagged moments on the timeline, and can reopen saved analyses from History. A flag is a prompt for human review, not a fatigue, injury-risk or safety assessment. The review decision itself happens outside the app.

**Construction worker being recorded (not yet supported).** As a construction worker whose video is analyzed, I want to understand what is processed, what is stored, and who can view my results, so I can discuss flagged moments with my supervisor.

What the app does today, which is what a worker would need to be told:

- **Processed:** the video is decoded and pose keypoints are extracted in the supervisor's browser. Only the keypoints are sent, through the Worker, to the Render model API for scoring. The video isn't uploaded.
- **Stored:** a single-person analysis saves a summary and its per-window scores and flags to D1 (see [History](#history-cloudflare-d1)). Video, keypoints and file names are never stored. Records carry no worker name or ID.
- **Who can view it:** everyone who has the team password. History is shared: anyone who logs in can see, open and delete every saved analysis.

The app has **no consent step, no worker account or worker view, and no way to share results with the person recorded.** Today, the supervisor would have to explain the points above and walk through the flagged moments with the worker in person. Consent and worker access would be future work.

## Login: one shared team password

The app has a single sign-in: **one password shared by the team**, stored as the Worker secret `APP_PASSWORD`. There are no individual accounts, no sign-up, no email login and no one-time codes. (The Better Auth account system that used to provide these has been removed; `/api/auth/*` no longer exists and answers 401, or 404 once logged in.)

How it works (`worker/gate.ts`, `worker/index.ts`):

- **The Worker runs before every request** (`assets.run_worker_first: true` in `wrangler.jsonc`), so the gate covers the page, its JavaScript and other files, not just the API.
- **Without a session**, any page request gets a small server-rendered login page (one password field) and no app code. Private API routes answer 401 "Please log in to use Motion Atlas."
- **Logging in** posts the form to `POST /api/login`. The Worker compares the password with `APP_PASSWORD` (comparing SHA-256 digests, so timing doesn't reveal how much matched). A wrong password gets the login page again with "That password isn't right." (HTTP 401) and no cookie.
- **A correct password** creates a session: 32 random bytes in the cookie `__Host-motion-atlas-session`, with `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`. The session lasts **12 hours**, then you log in again. D1 stores only the token's SHA-256 hash and its expiry (table `app_session`, migration `0003`), never the token or the password. Each login is its own session.
- **Log out** (button in the header) posts to `POST /api/logout`. That deletes the session row and clears the cookie, so a copied cookie stops working too.
- **Public without a session:** `GET /api/health` (the model wake-up call), `POST /api/login`, `POST /api/logout`, and `/favicon.png` and `/apple-touch-icon.png` for the login page.
- **Needs a session:** the app itself and its files, `POST /api/analyze/keypoints`, `GET/POST /api/history`, `GET/DELETE /api/history/<id>`, `GET /api/analytics`, and any other `/api/` path.
- With a session, `POST`/`DELETE` requests whose `Origin` is another site are refused (403), and so are login and logout forms posted from another site.
- **Missing configuration:** without `APP_PASSWORD` (or the `DB` binding), the login page and the private routes answer 503 "Login is not configured." No password is accepted, including an empty one. `/api/health` keeps working.

The password itself is never in the code, the client bundle, the docs, the logs or Git. Share it with the team (and the course hand-in) outside the repository. **Anyone who has it has full access**, including deleting History, so treat it as a prototype gate: **don't analyse confidential footage or sensitive personal data with it.** There is no limit on login attempts, so choose a long password.

**Cloudflare Access is separate.** The deployed hostname is also behind Cloudflare Access, which is configured in the Cloudflare dashboard, not in this repository. While Access is on, visitors see its email one-time-code screen before this login page. This code change doesn't remove that screen. See [Deploy](#deploy) for the dashboard change.

## History (Cloudflare D1)

After each successful analysis the app saves a summary to a D1 database (binding `DB`) and lists the recent saved analyses in the **History** section. Opening a row restores its summary, score timeline and flagged-moment times. To play those moments, open your local copy of the video; it's played in the browser only and isn't uploaded or re-analysed.

**What is stored** (`migrations/0001_create_analysis_history.sql`): analysis type, creation time, clip duration, window count, flagged-window count and share, threshold, model name, the interpretation sentence, the posture summary numbers, and per window: index, start/end time, score, and flag.
**What is never stored:** video, keypoints, raw IMU samples, file names. The Worker rejects save requests that contain any other field. Each record shows the generic label "Video analysis".

### History is shared

The shared password doesn't identify anyone, so there is **one History for the whole team**. Every record saved from now on gets the owner `shared-team` (in the `analysis_history.browser_id` column, whose name predates logins). Every History and Analytics query is limited to that owner. Anyone who logs in sees, opens and deletes the same records. The owner is set by the Worker; the app sends no ID, and the Worker ignores any it's sent.

**What this change does to records saved before it.** Until now, each record's owner was the Better Auth user ID of the account that saved it, or a random browser ID for records from before logins existed, and each user saw only their own. After this change:

- **None of those older records appear in the shared History or in Analytics.** They can't be opened or deleted through the app (they answer 404). Nobody's old records are shown to the rest of the team without someone deciding to.
- **They are not deleted or changed.** They stay in D1 exactly as they were. The 100-record limit only prunes `shared-team` records, so older rows are never pruned either.
- **The old account tables stay too.** `user`, `session`, `account` and `verification` (migration `0002`) are no longer read or written, but they still hold the old accounts' names, email addresses and password hashes. Delete them only if the team decides to (see [Deploy](#deploy)).
- **The shared History starts empty** on the first deploy.

To check what's there (read-only):
```powershell
npx wrangler d1 execute DB --remote --command "SELECT CASE WHEN browser_id = 'shared-team' THEN 'shared' WHEN browser_id IN (SELECT id FROM user) THEN 'old account' ELSE 'old browser ID' END AS owner, COUNT(*) AS records FROM analysis_history GROUP BY 1"
```

**Optional, and only if the account owners agree:** to move the old account records into the shared History, so everyone with the password can see and delete them:
```powershell
npx wrangler d1 execute DB --remote --command "UPDATE analysis_history SET browser_id = 'shared-team' WHERE browser_id IN (SELECT id FROM user)"
```
The shared History keeps 100 records. If adopting would take it past 100, the next save deletes the oldest ones beyond 100, so check the counts first. Records with an old browser ID have never belonged to anyone; they can be adopted the same way (`WHERE browser_id <> 'shared-team'`) or deleted.

**Limits.** The list returns the 20 newest records (`?limit=` accepts 1–50). The shared History keeps its newest 100 records; older ones are deleted when a new one is saved. A save is at most 2000 windows and 256 KiB.

**If saving fails**, the analysis stays on screen with a "not saved" message and a **Try saving again** button. History errors never affect `/api/analyze/keypoints`.

| Route | Purpose |
| --- | --- |
| `GET /api/history?limit=20` | the shared History's recent analyses (summary only) |
| `POST /api/history` | save one analysis summary |
| `GET /api/history/<id>` | one saved analysis with its per-window scores |
| `DELETE /api/history/<id>` | delete one saved analysis |

All four need a logged-in session (401 otherwise). A record outside the shared History answers 404.

## Analytics tab

The **Analytics** tab summarises the team's shared History. It shows:

- totals: saved analyses, scored windows, flagged windows and their share, how many analyses had at least one flagged window, and total clip time (analyses saved without a duration are counted separately);
- **saved analyses per period** (bar chart) and **flagged share of windows per period** (line chart). The period is a day for up to a month of data, a week for up to about six months, and a month beyond that. The flagged share is flagged windows ÷ all scored windows in that period. Periods with no saved analysis are left blank rather than shown as 0%;
- a short plain-language summary, including whether the flagged share was higher, lower or similar in the more recent periods. With fewer than four periods of data it makes no trend claim;
- a breakdown by analysis type. Today the app saves only single-person video analyses, so this just says so; other stored types would appear as a table;
- a note when the records were scored with more than one model/threshold setting, because flagged shares from different settings aren't directly comparable.

Each chart has a text description, a native hover tooltip on every mark, and a **Show the data as a table** view. The charts resize to the container width, so they work at phone width. Loading, error (with **Try again**) and empty states are shown explicitly. The data loads when you open the tab and reloads after a History save or delete.

**Data source and privacy boundary.** The tab calls `GET /api/analytics`, a read-only route. It needs a session, like History, and reads only the shared History (`WHERE browser_id = 'shared-team'`, set by the Worker). It never takes an owner from the query, headers or body, and older per-account records aren't included. It returns only the per-analysis summary columns: creation time, analysis type, duration, window count, flagged count and share, model name, and threshold. It returns no record IDs, per-window scores, posture numbers, video, keypoints or file names. Nothing is computed or stored outside the browser and this Worker, and there's no analytics tracking or third-party service. Multi-person results aren't saved to History, so they aren't included.

**Limits.** The shared History keeps only the newest 100 analyses, and deleted analyses are gone. The tab always says this, and shows a warning once the limit is reached, so the figures aren't read as lifetime totals. Times are grouped by your browser's local time zone.

**What the numbers aren't.** A flagged window is a movement deviation from the model's reference data, above the stored threshold. These scores are **not** measures of fatigue, workload, injury risk or safety, and the tab says so in every state.

| Route | Purpose |
| --- | --- |
| `GET /api/analytics` | the shared History's summary columns (at most 100, oldest first), plus `retention_limit` |

## Version 1 limitations shown in the app

- One pose per frame, with no reliable tracking of a single person. When other people are in view, the analysed pose may switch between them. The app warns when the pose jumps suddenly.
- It warns when knees and ankles aren't clearly detected, or when no person is found in parts of the video.
- Knee bend appears only as an experimental MoveNet estimate. On the test clips MoveNet reported about 5–6° more knee bend than YOLO, and the training data's detector is unknown.

## Local development

```powershell
# terminal 1, from the repository root: model API (same code as Render)
python -m uvicorn app:app --app-dir 02_model_server --host 127.0.0.1 --port 8000

# terminal 2
cd 03_app
npm install
copy .dev.vars.example .dev.vars      # then set APP_PASSWORD= to a local password of your choice in .dev.vars
npm run db:migrate:local              # create the local D1 tables (once, and after adding a migration)
npm run dev                           # Vite + the Worker (workerd) on one origin; log in with your local password
```

`.dev.vars` is ignored by Git. Use a different password locally than in production. Without `APP_PASSWORD`, the page and the private routes answer 503 "Login is not configured."

The session cookie is `Secure`. Chromium-based browsers and Firefox accept it on `http://localhost`. Safari may not, so use another browser for local development.

MoveNet weights are fetched from the model provider (tfhub.dev, which redirects to Kaggle storage) when the page loads.

### Local D1

`npm run dev` and `wrangler d1 ... --local` share the same local SQLite copy in `03_app/.wrangler/state` (ignored by Git). The `database_id` placeholder in `wrangler.jsonc` is enough for local work; no Cloudflare account is needed.

```powershell
npm run db:migrate:local                                                   # = npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations list DB --local                                 # show applied / pending migrations
npx wrangler d1 execute DB --local --command "SELECT id, browser_id, created_at, window_count, flagged_count FROM analysis_history ORDER BY created_at DESC LIMIT 5"
npx wrangler d1 execute DB --local --command "SELECT COUNT(*) AS active FROM app_session WHERE expires_at > unixepoch() * 1000"
```

To reset local History and sessions, stop `npm run dev`, delete `03_app/.wrangler/state`, and run `npm run db:migrate:local` again.

Add schema changes as new files (`migrations/0004_<name>.sql`, …). Don't edit an applied migration. Create one with `npx wrangler d1 migrations create DB <name>`.

## Deploy

What production needs:

| Setting | Kind | Where |
| --- | --- | --- |
| `APP_PASSWORD` | **secret** (the shared team password) | `npx wrangler secret put APP_PASSWORD`; never in `wrangler.jsonc`, `.dev.vars.example` or Git |
| `RENDER_API_URL` | plain variable | `wrangler.jsonc` → `vars` |
| `DB` → `motion-atlas-history` | D1 binding | `wrangler.jsonc` → `d1_databases` |
| `ASSETS`, `run_worker_first: true` | static assets served by the Worker after the login check | `wrangler.jsonc` → `assets` |
| migrations `0001`–`0003` | D1 schema (History; old auth tables; sessions) | `npm run db:migrate:remote` |

1. Redeploy the Render service, so the window start-time fix and `end_seconds` are live, and check that `RENDER_API_URL` in `wrangler.jsonc` is its URL.
2. Log in to Cloudflare and check the D1 database: `npx wrangler login`, then `npx wrangler d1 list` should show `motion-atlas-history` with the `database_id` that's in `wrangler.jsonc`. If it doesn't exist yet, create it with `npx wrangler d1 create motion-atlas-history` and copy the printed ID into `d1_databases[0].database_id`. Keep `binding: "DB"`.
3. Apply the migrations to the production database, **before** deploying the code that needs them. `0003` only adds the `app_session` table; it doesn't change or delete any existing row:
   ```powershell
   cd 03_app
   npx wrangler d1 migrations list DB --remote    # should show 0003_create_app_sessions.sql pending
   npm run db:migrate:remote                      # = npx wrangler d1 migrations apply DB --remote
   npx wrangler d1 migrations list DB --remote    # should now list nothing left to apply
   ```
4. Set the team password (once; again only to change it). Paste it at the prompt; don't put it in a file or on a command line:
   ```powershell
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret list                       # shows the names only, never the values
   ```
   Changing the password doesn't end existing sessions; they run out within 12 hours. To log everyone out at once:
   `npx wrangler d1 execute DB --remote --command "DELETE FROM app_session"`.
5. Run `npm run deploy`. Wrangler attaches the `DB` and `ASSETS` bindings from `wrangler.jsonc`; you don't need to add them in the dashboard.
6. Remove the old Better Auth secret, which the code no longer reads: `npx wrangler secret delete BETTER_AUTH_SECRET`.
7. Check: open the site, log in with the team password, analyse a clip, reload, and confirm it appears under History. Log out and check that the login page is shown and that `curl -i <site>/api/history` answers 401. In the dashboard, **Workers & Pages → motion-atlas → Settings** should show the binding `DB → motion-atlas-history` and the secret `APP_PASSWORD`.
8. **Cloudflare Access** is configured in the dashboard, not here, and keeps showing its email one-time-code screen until it's changed there. The steps to turn it off are in [Cloudflare Access](#cloudflare-access-dashboard-only).

**Old data (optional, the team's decision).** Nothing above deletes data. Records saved under the old accounts or browser IDs stay hidden (see [History is shared](#history-is-shared)). If the team decides the old accounts' personal data should go:
```powershell
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS accounts FROM user"
npx wrangler d1 execute DB --remote --command "DELETE FROM verification; DELETE FROM session; DELETE FROM account; DELETE FROM user"
```
This empties the old account tables but leaves them in place, so migration `0002` stays valid. It doesn't touch `analysis_history`.

If the Render service is still on the old code, the jump-to-moment times will be wrong whenever windows are dropped.

### Cloudflare Access (dashboard only)

The live hostname is protected by a Cloudflare Access application, which is what shows the email one-time-code screen. Nothing in this repository turns it on or off. To make the shared password the only sign-in:

1. **First** finish steps 3–7 above: migrations applied, `APP_PASSWORD` set, new Worker deployed. While Access is still on, pass its email code once and check that the new password page appears behind it. Turning Access off before that would expose the old app, whose sign-up was open to anyone.
2. In the Cloudflare dashboard, open **Workers & Pages → motion-atlas → Settings → Domains & Routes**. If the `workers.dev` row (and **Preview URLs**, if listed) shows **Cloudflare Access** enabled, disable it there.
3. Open **Zero Trust → Access → Applications** (in newer dashboards, **Zero Trust → Access controls → Applications**). Find any application whose domain is `motion-atlas.motion-atlas-team3.workers.dev` (or `*.motion-atlas-team3.workers.dev`). Open its **⋯** menu and choose **Delete**. Don't replace it with a "Bypass / Everyone" policy: deleting is clearer and leaves nothing to drift back.
4. Check from a private browser window or with curl:
   ```powershell
   curl.exe -sI https://motion-atlas.motion-atlas-team3.workers.dev/              # 200, no Location to *.cloudflareaccess.com
   curl.exe -si https://motion-atlas.motion-atlas-team3.workers.dev/api/history   # 401 {"detail":"Please log in to use Motion Atlas."}
   ```
   The browser should go straight to the Motion Atlas team-password page, with no email-code screen.

Leave the Zero Trust organization (the `*.cloudflareaccess.com` team domain) and its login methods alone; they don't affect this site once no Access application covers it.

## Checks

```powershell
python -m pytest 02_model_server/test_window_starts.py -q            # API window start times
cd 03_app; npm run build                                             # typecheck app + Worker, build
npm test                                                             # login gate, D1 history + analytics, migrations, UI states
npm run db:migrate:local; npm run dev   # then, in another terminal:
node tools/e2e_video_flow.mjs --url http://127.0.0.1:5173 --videos "<videos dir>" --clips "4.03.49,4.03.52"
node tools/e2e_video_flow.mjs --url http://127.0.0.1:5173 --videos "<videos dir>" --clips "4.03.49" --fail-save 1
```

`npm test` uses Node's test runner with a real local D1 (Miniflare, via wrangler). It needs Node 22.6 or newer, and no Cloudflare account. Tests log in through the Worker's own `/api/login` with a test-only password. It covers:
- the login gate (`test/gate.worker.test.mjs`):
  - right and wrong passwords;
  - missing `APP_PASSWORD` or `DB`;
  - the cookie's attributes and its D1 row (hash only);
  - forged and malformed cookies;
  - expiry and clean-up;
  - logout ending the session on the server;
  - that every private API, the app and its files need a session while health, login and the icons stay public;
  - that the old `/api/auth/*` routes (sign-up, email login, email OTP, session) are gone;
  - cross-site requests;
  - the `wrangler.jsonc` gate settings;
  - that no app source refers to the password;
- the migrations: columns, indexes, constraints, the `app_session` table, that the old tables are kept, and that `wrangler d1 migrations apply --local` applies them once;
- save, list, load and delete, including limits, validation, and rejection of raw-data fields;
- the shared History: every session sees the same records, older per-user records stay hidden and are never pruned, client-sent IDs are ignored, and logging out ends the session;
- the analysis route still working when history storage fails;
- the app's history client: it sends the session cookie and no browser ID, and reports a failed or logged-out save rather than throwing;
- analytics (`test/analytics*.test.mjs`):
  - the calculations: totals, window-weighted shares, day/week/month periods with gaps, type breakdown, retention-limit and mixed-scoring notices, and the text summary;
  - `/api/analytics`: login required, shared records only, client-sent IDs ignored, summary fields only, at most 100 records, read-only, and storage errors;
  - the tab's loading, error, empty, ready and at-limit states, rendered with React's server renderer after esbuild bundles the component into `node_modules/.cache`.

The end-to-end script runs in headless Edge and checks:
- the app sends exactly one analysis POST, containing keypoint JSON, plus one small history save without keypoints or the file name; no request carries video;
- the timeline and table use the API's start times;
- jump-to-moment moves the video to the right time;
- knee bend isn't in the main summary;
- after a reload, the analysis is in History, and opening it restores the timeline and flagged moments;
- with `--fail-save 1`, the analysis stays on screen and a "not saved" message is shown.

**The end-to-end script predates the login gate:** it doesn't log in, so against the current app it stops at the login page. It needs a login step (posting the team password to `/api/login`) before it can be used again.

## MoveNet vs YOLO comparison (prototype)

Keep frames and outputs out of Git (`prototype_out/` is ignored).

```powershell
# from the repository root
python 03_app/tools/decode_frames.py "<videos dir>" --out "<scratch>/frames"           # converter's exact 25 fps frames
python 03_app/tools/yolo_frames.py "<scratch>/frames" --out 03_app/prototype_out/yolo_frames_640
python 03_app/tools/yolo_frames.py "<scratch>/frames" --out 03_app/prototype_out/yolo_frames_960 --imgsz 960
cd 03_app; npm run build
node tools/browser_extract.mjs --frames "<scratch>/frames" --videos "<videos dir>" --out prototype_out
cd ..
python 03_app/tools/compare_extractors.py --frames "<scratch>/frames"
python 03_app/tools/compare_extractors.py --frames "<scratch>/frames" --exclude 4.03.44 4.03.47 4.03.35 --tag _single_person
```

YOLO is a comparison point, not ground truth. The numerical checks are prototype checks; they don't validate the anomaly scores.
