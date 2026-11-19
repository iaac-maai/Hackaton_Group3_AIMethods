# PROOFS — Application Verification

This document contains evidence that our application works correctly and meets the final submission requirements.

## 1. Database — Cloudflare D1

**Status:** PASS — Verified against the remote Cloudflare D1 database.

**Database:** `motion-atlas-history`

**Binding:** `DB`

**Verification command:**

```bash
cd 03_app
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

**Actual output:**

```text
Resource location: remote

Executing on remote database DB
Executed 1 command in 0.69ms

name
------------------
_cf_KV
account
analysis_history
d1_migrations
session
sqlite_sequence
user
verification
```

**Result:** The remote Cloudflare D1 database is accessible and contains the application tables, including `user`, `account`, `session`, and `analysis_history`.

**Conclusion:** Database connectivity and table existence verified.

## 2. Server-Side Security

**Status:** PASS — Application authentication verified locally; production protected by Cloudflare Access.

### Test A — Application-level authentication

**Endpoint:** `GET /api/history`

**Environment:** Local development server (`localhost:5173`)

**Command:**

```powershell
curl.exe -i "http://localhost:5173/api/history"
```

**Actual response:**

```text
HTTP/1.1 401 Unauthorized
content-type: application/json
cache-control: no-store

{"detail":"Please log in to use Motion Atlas."}
```

**Result:** The application rejects unauthenticated requests to the protected history endpoint with HTTP 401.

### Test B — Production access protection

**Endpoint:** `https://motion-atlas.motion-atlas-team3.workers.dev/api/history`

**Command:**

```powershell
curl.exe -i "https://motion-atlas.motion-atlas-team3.workers.dev/api/history"
```

**Actual response:**

```text
HTTP 302 Found
Server: cloudflare
Location: https://crimson-dew-8ff2.cloudflareaccess.com/...
```

**Result:** Cloudflare Access redirects unauthenticated production requests to its login system before they reach the Worker.

**Conclusion:** The application's authentication guard is verified locally, and production access is additionally protected by Cloudflare Access. An application-level HTTP 401 has not been directly observed in production.

## 3. Render Model Connection

**Status:** Verified — keypoint prediction endpoint operational.

**Evidence:**

- **Render service:** `https://construction-safety-model-api.onrender.com`
- **Prediction endpoint:** `POST /predict/keypoints`
- **HTTP response:** `200 OK`
- **Test input:** 192 frames containing 17 keypoints with 3 values per keypoint.
- **Model:** `A Dense, latent 16`
- **Windows analyzed:** 4
- **Reconstruction threshold:** 0.6588426828384399
- **Windows above threshold:** 0
- **Response:** Valid JSON containing reconstruction scores, threshold comparisons, window information, and posture summary.

**Verification method:**

A Python script generated synthetic walking keypoint data using the project's `walking_clip()` test function and submitted the frames directly to the deployed Render prediction endpoint.

The Render service returned HTTP 200 with a structured prediction response.

**Conclusion:** The deployed Render service successfully accepts keypoint data, executes the keypoint model, and returns prediction results. The Cloudflare Worker forwarding implementation has also been identified in `03_app/worker/index.ts`, but successful end-to-end forwarding through the Worker has not yet been independently verified.

**Note:** The health endpoint previously reported a degraded status because the separate IMU model could not load. This does not invalidate the successful keypoint prediction test.

## 4. No Secrets in Git

**Status:** Pending final Git verification.

**Evidence:**

- The application uses `03_app/.dev.vars` for local environment configuration.
- Git inspection commands were executed to check ignored and tracked files.
- The visible terminal output does not establish the results of those Git checks.

**Leaked secrets question:** If a secret is committed or exposed, immediately revoke or rotate it, remove it from the repository and Git history where appropriate, and investigate potential misuse. Removing a secret from the latest commit alone is insufficient.

**Conclusion:** Secret-handling verification remains pending until the Git output is confirmed.

## 5. User Accounts

**Status:** Partially verified — authentication implementation confirmed.

**Evidence:**

- Authentication is implemented using Better Auth.
- The Worker checks authentication before allowing access to protected history endpoints.
- An unauthenticated GET request to `/api/history` returned HTTP `401 Unauthorized`.
- The response was `{"detail":"Please log in to use Motion Atlas."}`.
- The Worker obtains the authenticated user ID from the server-verified session.

**Conclusion:** Authentication enforcement is confirmed. Successful signup, login, and logout still require functional testing.

## 6. User Data Isolation

**Status:** Partially verified — database ownership checks confirmed.

**Evidence:**

- Protected history operations receive the authenticated user ID from the Worker.
- `03_app/worker/history.ts` uses parameterized SQL queries.
- History record access is restricted using `WHERE id = ?1 AND browser_id = ?2`.
- The query binds the requested record ID and authenticated user ID.
- Record deletion uses the same ownership restriction.
- Unauthenticated history requests return HTTP `401 Unauthorized`.

**Conclusion:** The implementation enforces user-specific ownership checks for the inspected history operations. A two-account test is still required to confirm that User B cannot access User A's private records.

---

## Submission Notes

**Project:** Motion Atlas — Construction Safety Movement Analysis

**Application URL:** https://motion-atlas.motion-atlas-team3.workers.dev

**Model API:** https://construction-safety-model-api.onrender.com

**Database:** Cloudflare D1 (`motion-atlas-history`)

**Verification Summary:**
- Cloudflare D1 connectivity and database tables verified.
- Unauthenticated access to protected history endpoints returns HTTP 401.
- Render keypoint prediction endpoint successfully returned HTTP 200 with valid JSON.
- Authentication and user-specific database ownership checks inspected.
- Remaining functional and security checks are documented in the corresponding proof sections.

**Test Accounts:**

Test-account credentials and application passwords will be provided through the course hand-in system, never in this repository.

**Known Limitations:**

- The Render IMU model currently fails to load; the keypoint model successfully processes prediction requests.
- End-to-end Cloudflare Worker-to-Render forwarding has not yet been independently verified.
- Signup, login, logout, and cross-user data isolation require final functional testing.
- Git secret-hygiene verification remains pending.

**Security Note:**

No passwords, API keys, authentication tokens, or other secrets are intentionally included in this submission document.