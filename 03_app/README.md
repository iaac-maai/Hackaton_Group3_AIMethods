# Motion Atlas app

Video-first movement analysis. You pick a video and the browser extracts one body pose per frame with MoveNet SinglePose Lightning, at 25 fps. Only the keypoints are sent. They go to the Cloudflare Worker, which forwards them to the existing Render model API (`POST /predict/keypoints`). The page then shows:

- the per-window scores on a timeline;
- the flagged moments, using the start and end times returned by the API;
- the local video with the analysed skeleton drawn over it;
- the input-quality warnings.

**The raw video never leaves the browser.** IMU CSV analysis isn't in this app yet.

## Login (Better Auth)

You need an account to use the app. The page shows a sign-up / log-in screen (email and password) until you're logged in, and **Log out** in the header ends the session. Accounts and sessions are handled by [Better Auth](https://www.better-auth.com/) in the Worker (`worker/auth.ts`, routes under `/api/auth/*`) and stored in the same D1 database (`migrations/0002_create_auth_tables.sql`: `user`, `session`, `account`, `verification`).

- The session is an HttpOnly cookie that the browser sends on same-origin requests. The Worker checks it on every protected route.
- **Analysis (`/api/analyze/keypoints`) and History (`/api/history…`) need a valid session.** Without one they answer 401 "Please log in to use Motion Atlas." `/api/health` and the page itself stay public.
- Whose history a request sees comes **only** from the verified session. The app sends no browser or user ID, and the Worker ignores any it's sent.
- Sign-up is open to anyone who can reach the site, and email addresses aren't verified. Treat this as a prototype: **don't analyse confidential footage or sensitive personal data with it.**

## History (Cloudflare D1)

After each successful analysis the app saves a summary to a D1 database (binding `DB`) and lists your recent saved analyses in the **History** section. Opening a row restores its summary, score timeline and flagged-moment times. To play those moments, open your local copy of the video; it's played in the browser only and isn't uploaded or re-analysed.

**What is stored** (`migrations/0001_create_analysis_history.sql`): analysis type, creation time, clip duration, window count, flagged-window count and share, threshold, model name, the interpretation sentence, the posture summary numbers, and per window: index, start/end time, score, and flag.
**What is never stored:** video, keypoints, raw IMU samples, file names. The Worker rejects save requests that contain any other field. Each record shows the generic label "Video analysis".

**Per-user.** Each record belongs to the logged-in user who saved it (the user ID is stored in the `analysis_history.browser_id` column, whose name predates accounts). You see the same history on any browser or device you log in from. Another user's records answer 404, and there's no endpoint that lists everyone's history.

**Limits.** The list returns the 20 newest records (`?limit=` accepts 1–50). Each user keeps their newest 100 records; older ones are deleted when a new one is saved. A save is at most 2000 windows and 256 KiB.

**If saving fails**, the analysis stays on screen with a "not saved" message and a **Try saving again** button. History errors never affect `/api/analyze/keypoints`.

| Route | Purpose |
| --- | --- |
| `GET /api/history?limit=20` | your recent analyses (summary only) |
| `POST /api/history` | save one analysis summary |
| `GET /api/history/<id>` | one saved analysis with its per-window scores |
| `DELETE /api/history/<id>` | delete one saved analysis |

All four need a logged-in session (401 otherwise). Another user's record answers 404.

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
copy .dev.vars.example .dev.vars      # RENDER_API_URL=http://127.0.0.1:8000, BETTER_AUTH_SECRET=<fill in>
npx @better-auth/cli secret           # prints a random secret: paste it after BETTER_AUTH_SECRET= in .dev.vars
npm run db:migrate:local              # create the local D1 tables (once, and after adding a migration)
npm run dev                           # Vite + the Worker (workerd) on one origin; sign up on the page
```

`.dev.vars` is ignored by Git. Use a different secret locally than in production. Without `BETTER_AUTH_SECRET`, login, analysis and History answer 503 "Authentication is not configured."

MoveNet weights are fetched from the model provider (tfhub.dev, which redirects to Kaggle storage) when the page loads.

### Local D1

`npm run dev` and `wrangler d1 ... --local` share the same local SQLite copy in `03_app/.wrangler/state` (ignored by Git). The `database_id` placeholder in `wrangler.jsonc` is enough for local work; no Cloudflare account is needed.

```powershell
npm run db:migrate:local                                                   # = npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations list DB --local                                 # show applied / pending migrations
npx wrangler d1 execute DB --local --command "SELECT id, created_at, window_count, flagged_count FROM analysis_history ORDER BY created_at DESC LIMIT 5"
npx wrangler d1 execute DB --local --command "SELECT id, email, created_at FROM user"
```

To reset local history and accounts, stop `npm run dev`, delete `03_app/.wrangler/state`, and run `npm run db:migrate:local` again.

Add schema changes as new files (`migrations/0003_<name>.sql`, …). Don't edit an applied migration. Create one with `npx wrangler d1 migrations create DB <name>`.

## Deploy

What production needs:

| Setting | Kind | Where |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | **secret** (signs session cookies) | `npx wrangler secret put BETTER_AUTH_SECRET`; never in `wrangler.jsonc` or Git |
| `RENDER_API_URL` | plain variable | `wrangler.jsonc` → `vars` |
| `DB` → `motion-atlas-history` | D1 binding | `wrangler.jsonc` → `d1_databases` |
| migrations `0001`, `0002` | D1 schema (history; auth tables) | `npm run db:migrate:remote` |

There's no `BETTER_AUTH_URL` to set: the Worker uses the site's own origin as the Better Auth base URL.

1. Redeploy the Render service, so the window start-time fix and `end_seconds` are live, and check that `RENDER_API_URL` in `wrangler.jsonc` is its URL.
2. Log in to Cloudflare and check the D1 database: `npx wrangler login`, then `npx wrangler d1 list` should show `motion-atlas-history` with the `database_id` that's in `wrangler.jsonc`. If it doesn't exist yet, create it with `npx wrangler d1 create motion-atlas-history` and copy the printed ID into `d1_databases[0].database_id`. Keep `binding: "DB"`.
3. Apply the migrations to the production database, **before** deploying the code that needs them:
   ```powershell
   cd 03_app
   npx wrangler d1 migrations list DB --remote    # shows what's pending (0002 adds the login tables)
   npm run db:migrate:remote                      # = npx wrangler d1 migrations apply DB --remote
   npx wrangler d1 migrations list DB --remote    # should now list nothing left to apply
   ```
4. Set the auth secret (once; again only to rotate it). Generate a long random value, for example with `npx @better-auth/cli secret`, and paste it at the prompt. Don't put it in a file or a command line:
   ```powershell
   npx wrangler secret put BETTER_AUTH_SECRET
   npx wrangler secret list                       # shows the name only, never the value
   ```
   Rotating the secret logs everyone out.
5. Run `npm run deploy`. Wrangler attaches the `DB` binding from `wrangler.jsonc`; you don't need to add it in the dashboard.
6. Check: open the site, sign up, analyse a clip, reload, and confirm it appears under History. Log out and check that History and analysis ask you to log in. In the dashboard, **Workers & Pages → motion-atlas → Settings** should show the binding `DB → motion-atlas-history` and the secret `BETTER_AUTH_SECRET`.

**History saved before login existed** was keyed by a random browser ID, so it doesn't belong to any account and no user can see it. It stays in D1 until you delete it. To check for and remove it once logins are live:
```powershell
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS orphaned FROM analysis_history WHERE browser_id NOT IN (SELECT id FROM user)"
npx wrangler d1 execute DB --remote --command "DELETE FROM analysis_history WHERE browser_id NOT IN (SELECT id FROM user)"
```

Apply new migrations with `npm run db:migrate:remote` **before** deploying code that needs them.

If the Render service is still on the old code, the jump-to-moment times will be wrong whenever windows are dropped.

## Checks

```powershell
python -m pytest 02_model_server/test_window_starts.py -q            # API window start times
cd 03_app; npm run build                                             # typecheck app + Worker, build
npm test                                                             # D1 history: migration, routes, scoping, failures
npm run db:migrate:local; npm run dev   # then, in another terminal:
node tools/e2e_video_flow.mjs --url http://127.0.0.1:5173 --videos "<videos dir>" --clips "4.03.49,4.03.52"
node tools/e2e_video_flow.mjs --url http://127.0.0.1:5173 --videos "<videos dir>" --clips "4.03.49" --fail-save 1
```

`npm test` uses Node's test runner with a real local D1 (Miniflare, via wrangler). It needs Node 22.6 or newer, and no Cloudflare account. Test users sign up through the Worker's own Better Auth routes with a test-only secret. It covers:
- the migrations: columns, indexes, constraints, and that `wrangler d1 migrations apply --local` applies them once;
- save, list, load and delete, including limits, validation, and rejection of raw-data fields;
- login: every history and analysis route needs a valid session, users only see their own records, client-sent IDs are ignored, and logging out ends the session;
- the analysis route still working when history storage fails;
- the app's history client: it sends the session cookie and no browser ID, and reports a failed or logged-out save rather than throwing.

`better-sqlite3` (a dev dependency, used only by `auth.config.ts` for Better Auth schema generation) is pinned to 12.x, which installs a prebuilt binary. Version 13 compiles from source on install and fails without a C++ toolchain.

The end-to-end script runs in headless Edge and checks:
- the app sends exactly one analysis POST, containing keypoint JSON, plus one small history save without keypoints or the file name; no request carries video;
- the timeline and table use the API's start times;
- jump-to-moment moves the video to the right time;
- knee bend isn't in the main summary;
- after a reload, the analysis is in History, and opening it restores the timeline and flagged moments;
- with `--fail-save 1`, the analysis stays on screen and a "not saved" message is shown.

**The end-to-end script predates login:** it doesn't sign up or log in, so against the current app it stops at the login screen. It needs a sign-up/log-in step before it can be used again.

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
