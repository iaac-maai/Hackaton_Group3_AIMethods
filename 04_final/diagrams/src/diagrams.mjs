// The four Motion Atlas diagrams. Coordinates are on a 1920 × 1080 (16:9 slide) canvas.
// Every label is checked against the code in 03_app/ and 02_model_server/ (see ../README.md).
import {
  T, HEAD, page, zone, node, pill, arrow, diamond, dot, text, eyebrow, rect, lifeline, msg, divider, frag, legendWithout, timeAxis,
} from "./lib.mjs";

// ---------------------------------------------------------------------------------------------
// 1. System architecture
// ---------------------------------------------------------------------------------------------
function systemArchitecture() {
  // Columns: browser | shared-password gate (run by the Worker first) | Worker routes | Hugging Face, Render and D1.
  const B = { x: 72, w: 470 }, G = { x: 552, w: 182 }, Wk = { x: 744, w: 486 }, R = { x: 1392, w: 456 };
  const bx = B.x + 24, bw = B.w - 48, wx = Wk.x + 24, ww = Wk.w - 48;
  const gapL = [bx + bw, wx], gapR = [wx + ww, R.x];
  const midL = G.x + G.w / 2, midR = (gapR[0] + gapR[1]) / 2;
  const GATE_FILL = "#13111f";   // opaque, so arrow labels on the gate get a matching halo
  const gl = { halo: GATE_FILL };
  // Architecture block, laid out from y = 210 and shifted down by ARCH_DY to sit below the summary row.
  const ARCH_DY = 74;
  const arch = [
    zone({ x: B.x, y: 210, w: B.w, h: 712, kicker: "User’s device", title: "Browser · Motion Atlas app" }),
    pill(B.x + B.w - 24, 230, "Video never uploaded", { tone: "privacy", anchor: "end" }),
    node({ x: bx, y: 316, w: bw, h: 96, title: "Log in", body: ["One shared team password", "Session kept as an HttpOnly cookie"] }),
    node({ x: bx, y: 428, w: bw, h: 248, title: "Video → pose keypoints", tone: "privacy", body: [
      "Upload a video or record one", "MoveNet runs in the browser (TF.js)", "One person, or several as tracks A, B, C", "25 fps · 17 keypoints per pose",
      "Picking a video wakes the model server"] }),
    node({ x: bx, y: 692, w: bw, h: 100, title: "Results", body: ["Scores, threshold and flagged moments", "Local playback with skeleton"] }),
    node({ x: bx, y: 808, w: bw, h: 94, title: "History panel", body: ["Team’s shared History (newest 20)", "Open one again · optional local replay"] }),

    // The Worker's shared-password gate runs first for every request (assets.run_worker_first).
    rect(G.x, 210, G.w, 712, { r: 20, fill: GATE_FILL, stroke: T.custom, so: 0.5 }),
    eyebrow(G.x + 20, 248, "Worker · first", { fill: T.custom }),
    text(G.x + 20, 280, "Password gate", { size: 19, weight: 800, font: HEAD, fill: T.ink }),
    text(G.x + 20, 306, "All but /api/health", { size: 15, fill: T.ink2 }),

    zone({ x: Wk.x, y: 210, w: Wk.w, h: 712, kicker: "Cloudflare", title: "Worker · motion-atlas" }),
    pill(Wk.x + Wk.w - 24, 230, "Serves the app + /api", { anchor: "end" }),
    node({ x: wx, y: 316, w: ww, h: 96, title: "POST /api/login · /api/logout", body: ["Checks the APP_PASSWORD secret", "Creates and ends 12 h sessions"] }),
    node({ x: wx, y: 428, w: ww, h: 124, title: "Session check", tone: "protected", body: [
      "App, analysis, History, Analytics", "Token hash looked up in D1", "None → login page or 401"] }),
    node({ x: wx, y: 568, w: ww, h: 76, title: "GET /api/health", body: ["No session needed · forwards to Render"] }),
    node({ x: wx, y: 660, w: ww, h: 96, title: "POST /api/analyze/keypoints", tone: "protected", body: ["Forwards keypoints to Render", "Returns its response unchanged"] }),
    node({ x: wx, y: 772, w: ww, h: 130, title: "/api/history", tone: "protected", body: [
      "List · save · open · delete", "Shared History · summary fields only", "Keeps the newest 100"] }),

    node({ x: R.x, y: 316, w: R.w, h: 104, kicker: "Cloudflare D1", title: "app_session", body: ["Token hash + expiry · no personal data"] }),
    node({ x: R.x, y: 436, w: R.w, h: 96, kicker: "Hugging Face", title: "Model repo", body: ["model.onnx · scaler.npz · config.json"] }),
    node({ x: R.x, y: 596, w: R.w, h: 150, kicker: "Render", title: "Model server (FastAPI)", body: [
      "GET /health loads the models", "POST /predict/keypoints → ONNX autoencoder", "1.92 s windows · deviation from reference"] }),
    node({ x: R.x, y: 772, w: R.w, h: 130, kicker: "Cloudflare D1", title: "analysis_history", body: ["Summaries and per-window scores", "Owner = shared-team (one History)"] }),

    // Browser ↔ Worker, through the password gate
    arrow([[gapL[0] + 4, 352], [gapL[1] - 4, 352]], { label: "team password", at: [midL, 342], ...gl }),
    arrow([[gapL[1] - 4, 392], [gapL[0] + 4, 392]], { style: "res", label: "session cookie", at: [midL, 382], ...gl }),
    arrow([[gapL[0] + 4, 600], [gapL[1] - 4, 600]], { label: "GET /api/health", at: [midL, 590], ...gl }),
    text(midL, 622, "wake-up, reply ignored", { size: 15, fill: T.muted, anchor: "middle", halo: GATE_FILL }),
    arrow([[gapL[0] + 4, 668], [gapL[1] - 4, 668]], { label: "keypoints + cookie", at: [midL, 658], ...gl }),
    arrow([[gapL[1] - 4, 740], [gapL[0] + 4, 740]], { style: "res", label: "scores, flags, times", at: [midL, 730], ...gl }),
    arrow([[gapL[0] + 4, 830], [gapL[1] - 4, 830]], { label: "summary + scores", at: [midL, 820], ...gl }),
    arrow([[gapL[1] - 4, 880], [gapL[0] + 4, 880]], { style: "res", label: "saved items", at: [midL, 870], ...gl }),
    // Worker ↔ Render / D1
    arrow([[gapR[0] + 4, 352], [gapR[1] - 4, 352]], { label: "session hash", at: [midR, 342] }),
    arrow([[gapR[0] + 4, 476], [R.x - 28, 476], [R.x - 28, 404], [R.x - 4, 404]], { label: "look up session", at: [gapR[0] + 14, 466], anchor: "start" }),
    arrow([[gapR[0] + 4, 606], [gapR[1] - 4, 606]], { label: "GET /health", at: [midR, 596] }),
    arrow([[gapR[0] + 4, 680], [gapR[1] - 4, 680]], { label: "keypoints", at: [midR, 670] }),
    arrow([[gapR[1] - 4, 730], [gapR[0] + 4, 730]], { style: "res", label: "scores, flags, times", at: [midR, 720] }),
    arrow([[gapR[0] + 4, 830], [gapR[1] - 4, 830]], { label: "shared rows only", at: [midR, 820] }),
    // Hugging Face → Render: model files fetched with snapshot_download on the first model load
    arrow([[R.x + 56, 532 + 4], [R.x + 56, 596 - 4]], { label: "snapshot_download", at: [R.x + 76, 558], anchor: "start" }),
    text(R.x + 76, 581, "first model load at start-up, then cached", { size: 15, fill: T.muted, halo: T.page }),
  ];
  const body = [
    // What crosses the boundary: summary row below the subtitle
    `<g id="summary-row">`,
    ...[
      ["Stays in the browser", "Video, camera recordings, skeleton overlay", "privacy"],
      ["Sent to the Worker", "Keypoints to score · summaries to save", "default"],
      ["Stored in D1", "Session hashes, summaries · never video or keypoints", "default"],
    ].map(([k, v, tone], i) => node({ x: 72 + i * 600, y: 184, w: 576, h: 78, kicker: k, body: [v], tone })),
    `</g>`,
    `<g id="architecture" transform="translate(0 ${ARCH_DY})">`, ...arch, `</g>`,
  ];
  return page({
    num: "01 System architecture",
    title: "System architecture",
    subtitle: "The video stays on the device. One team password gates the app; keypoints and summaries are sent only with a valid session.",
    legendItems: [...legendWithout("key", "warn", "decision"), { box: "gate", label: "Shared-password gate (in the Worker)" }],
    footnote: "Source: 03_app/worker (index.ts, gate.ts), 03_app/src, 02_model_server/app.py, model_loader.py",
    body: body.join("\n"),
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Site-supervisor user flow
// ---------------------------------------------------------------------------------------------
function historyRow(x, y, w, date, dur, flagged) {
  return `<g>${rect(x, y, w, 40, { r: 12, fill: T.ink, fo: 0.03, so: 0.08 })}`
    + text(x + 16, y + 26, [[date, { fill: T.ink, weight: 600 }], [" · Video analysis", { fill: T.ink2 }], [` · ${dur} · ${flagged}`, { fill: T.muted }]], { size: 16 })
    + `</g>`;
}

function miniTimeline(x, y, w, h, scores, threshold) {
  const n = scores.length, gap = 4, bw = (w - gap * (n - 1)) / n, max = 1;
  const ty = y + h - threshold * h / max;
  const bars = scores.map((s, i) => {
    const bh = s * h / max;
    return `<rect x="${(x + i * (bw + gap)).toFixed(1)}" y="${(y + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${s > threshold ? T.accent : T.bar}"/>`;
  }).join("");
  return `<g><line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="${T.axis}"/>${bars}`
    + `<line x1="${x - 4}" y1="${ty}" x2="${x + w + 4}" y2="${ty}" stroke="${T.threshold}" stroke-width="2"/>`
    + text(x + w, ty - 7, "trained threshold", { size: 13, weight: 600, fill: T.threshold, anchor: "end", halo: T.surface }) + `</g>`;
}

function supervisorFlow() {
  const C3 = { x: 1132, w: 716 };
  const body = [
    // User story
    node({ x: 72, y: 190, w: 1776, h: 92, kicker: "User story · site lead", tone: "start", body: [] }),
    text(94, 262, "“As a site lead, I want a simple overview of analyzed clips and unusual movement windows, so I can decide what deserves review.”",
      { size: 22, weight: 600, font: HEAD, fill: T.ink }),

    eyebrow(72, 336, "1 · Log in"), eyebrow(452, 336, "2 · Analyze a clip"), eyebrow(C3.x, 336, "3 · Overview and review"),

    // Column 1: log in with the shared team password
    node({ x: 97, y: 362, w: 250, h: 64, r: 32, tone: "start", title: "Open Motion Atlas", center: true, titleSize: 20 }),
    arrow([[222, 426], [222, 456]]),
    diamond(222, 518, 220, 120, ["Logged in?"]),
    arrow([[222, 578], [222, 634]], { label: "No", at: [236, 612], anchor: "start" }),
    node({ x: 72, y: 638, w: 300, h: 108, title: "Log in", body: ["Shared team password", "Sets the session cookie"] }),
    arrow([[332, 518], [566, 518]], { label: "Yes", at: [352, 506], anchor: "start" }),
    `<path d="M372,692 H412 V518" fill="none" stroke="${T.ink2}" stroke-width="2"/>`, dot(412, 518),
    node({ x: 72, y: 778, w: 300, h: 112, tone: "ghost", title: "Login required", titleSize: 19, body: ["Login page instead of the app;", "the API answers 401 without one"] }),

    // Column 2: analyze
    node({ x: 572, y: 466, w: 360, h: 104, title: "Choose a clip", tone: "privacy", body: ["Upload a video or record one", "Pose found in the browser"] }),
    arrow([[752, 570], [752, 606]]),
    diamond(752, 664, 300, 112, ["Analyze multiple", "people?"]),
    arrow([[602, 664], [527, 664], [527, 762]], { label: "On", at: [560, 652] }),
    arrow([[902, 664], [977, 664], [977, 762]], { label: "Off", at: [942, 652] }),
    node({ x: 452, y: 766, w: 290, h: 132, title: "Multiple people", body: ["Tracks A, B, C … per clip", "Each track scored separately", "Not saved to History"] }),
    node({ x: 762, y: 766, w: 290, h: 132, title: "Single person", body: ["One pose per frame", "Scored per 1.92 s window", "Saved to History"] }),
    arrow([[597, 898], [597, 920]]),
    node({ x: 452, y: 922, w: 290, h: 110, tone: "warn", title: "Identity can be uncertain", titleSize: 19, body: ["Split into stretches, not", "combined as one person"] }),
    arrow([[907, 898], [907, 920]]),
    // Save outcome (single person)
    rect(762, 922, 290, 110, { r: 14, fill: T.surface, so: 0.1 }),
    rect(774, 934, 266, 36, { r: 10, fill: T.ok, fo: 0.12, stroke: T.ok, so: 0.5 }),
    text(790, 958, "✓ Saved to history", { size: 16, weight: 600, fill: T.ink }),
    rect(774, 980, 266, 40, { r: 10, fill: T.warnBg, stroke: T.warnInk, so: 0.25 }),
    text(790, 1005, [["⚠ Not saved", { weight: 700 }], [" · results stay · retry", {}]], { size: 15, fill: T.warnInk }),

    // Saved → History (overview)
    arrow([[1052, 952], [1092, 952], [1092, 450], [C3.x - 2, 450]]),
    `<text x="1080" y="700" transform="rotate(-90 1080 700)" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="15" font-weight="500" fill="${T.ink2}" text-anchor="middle">saved summary</text>`,

    // Column 3: review path
    node({ x: C3.x, y: 362, w: C3.w, h: 182, tone: "key", title: "History · overview of analyzed clips" }),
    pill(C3.x + C3.w - 22, 376, "example rows", { anchor: "end", size: 13 }),
    historyRow(C3.x + 26, 412, C3.w - 48, "19 Nov, 14:05", "42.2 s", "4 of 22 windows flagged (18%)"),
    historyRow(C3.x + 26, 458, C3.w - 48, "19 Nov, 11:40", "18.6 s", "0 of 9 windows flagged (0%)"),
    text(C3.x + 26, 524, "Newest 20 in the team’s shared History · summaries only", { size: 16, fill: T.muted }),
    arrow([[C3.x + 60, 544], [C3.x + 60, 580]], { style: "key", label: "Open a clip", at: [C3.x + 76, 568], anchor: "start" }),
    node({ x: C3.x, y: 582, w: C3.w, h: 124, tone: "key", title: "Flagged time windows", body: ["Start–end times from the scoring API"] }),
    pill(C3.x + 26, 658, "▶ 0:11.5–0:13.4", { size: 15 }), text(C3.x + 186, 678, "score 0.41", { size: 15, fill: T.muted }),
    pill(C3.x + 290, 658, "▶ 0:24.9–0:26.9", { size: 15 }), text(C3.x + 450, 678, "score 0.37", { size: 15, fill: T.muted }),
    arrow([[C3.x + 60, 706], [C3.x + 60, 738]], { style: "key" }),
    node({ x: C3.x, y: 740, w: C3.w, h: 152, tone: "key", title: "Score and threshold context", body: [
      "Score = movement deviation from", "the model’s reference data", "Trained threshold is fixed; a custom", "one is for exploring only"] }),
    miniTimeline(C3.x + 418, 790, 270, 80, [0.18, 0.22, 0.2, 0.55, 0.62, 0.24, 0.19, 0.26, 0.21, 0.48, 0.2, 0.17], 0.42),
    arrow([[C3.x + 60, 892], [C3.x + 60, 922]], { style: "key" }),
    node({ x: C3.x, y: 924, w: C3.w, h: 108, tone: "key", title: "Site lead decides what deserves review", body: [
      "Replay the moment from the local video, then follow up on site or move on.", "This decision is made by the site lead and is not recorded in the app."] }),
  ];
  return page({
    num: "02 Site-lead user flow",
    title: "Site-lead user flow",
    subtitle: "From a logged-in session to an overview of analyzed clips, then into one flagged moment with its score and threshold.",
    legendItems: legendWithout("res"),
    footnote: "Example values are illustrative",
    body: body.join("\n"),
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Analysis and save sequence
// ---------------------------------------------------------------------------------------------
function analysisAndSave() {
  const L = 150, Bx = 430, Wx = 720, Rx = 1010, Dx = 1290, top = 180, bottom = 1036;
  const P = { x: 1440, w: 408 };
  const note = (x, y, lines, tone = "default", w = 254) => node({ x: x + 14, y, w, h: 28 + lines.length * 24, body: lines, tone, bodySize: 16 });
  const body = [
    timeAxis(40, 262, 1030),
    lifeline(L, "Actor", "Site lead", top, bottom),
    lifeline(Bx, "User’s device", "Browser app", top, bottom),
    lifeline(Wx, "Cloudflare", "Worker", top, bottom),
    lifeline(Rx, "Render", "Scoring API", top, bottom),
    lifeline(Dx, "Cloudflare", "D1", top, bottom),

    divider(72, 274, 1328, "Analysis · logged in, cookie sent with each request"),
    msg(L, Bx, 304, "Choose a video or record one"),
    note(Bx, 316, ["Keypoints extracted here", "The video is not uploaded"], "privacy"),
    msg(Bx, Wx, 418, "POST /api/analyze/keypoints", { label2: "keypoints + session cookie" }),
    note(Wx, 430, ["Verify session", "No session → 401"], "protected"),
    msg(Wx, Rx, 536, "POST /predict/keypoints", { label2: "scored in 1.92 s windows" }),
    msg(Rx, Bx, 600, "scores · flags · window times", { style: "res", labelX: Rx - 150, label2: "passed through by the Worker" }),
    msg(Bx, L, 648, "Results on screen", { style: "res" }),

    divider(72, 690, 1328, "Save to History · automatic, separate from the analysis"),
    msg(Bx, Wx, 726, "POST /api/history", { label2: "summary + window scores only" }),
    note(Wx, 738, ["Verify session", "Owner = shared-team"], "protected"),
    msg(Wx, Dx, 832, "Insert row · keep newest 100"),
    frag(72, 850, 1328, 176, [
      { y: 850, guard: "[saved]", tone: "ok" },
      { y: 934, guard: "[failed: network error, 401, 4xx or 5xx]", tone: "warn" },
    ]),
    msg(Dx, Wx, 884, "ok", { style: "res" }),
    msg(Wx, Bx, 916, "201 · saved item", { style: "res" }),
    msg(Wx, Bx, 998, "error message, or no response", { style: "warn" }),

    // What the site lead sees
    eyebrow(P.x, 274, "On screen"),
    rect(P.x, 290, P.w, 376, { r: 14, fill: T.surface, so: 0.1 }),
    text(P.x + 22, 326, "Results", { size: 21, weight: 700, font: HEAD, fill: T.ink }),
    pill(P.x + P.w - 22, 304, "example", { anchor: "end", size: 13 }),
    rect(P.x + 22, 344, P.w - 44, 92, { r: 12, fill: T.surface2, so: 0.1 }),
    `<rect x="${P.x + 22}" y="344" width="${P.w - 44}" height="3" rx="1.5" fill="${T.threshold}"/>`,
    text(P.x + 40, 374, "WINDOWS ABOVE THRESHOLD", { size: 13, weight: 600, fill: T.ink2, ls: 0.6 }),
    text(P.x + 40, 414, [["4 ", { fill: T.ink, weight: 700 }], ["of 22", { fill: T.muted, weight: 500 }]], { size: 30 }),
    miniTimeline(P.x + 34, 470, P.w - 68, 80, [0.2, 0.24, 0.18, 0.58, 0.63, 0.22, 0.2, 0.27, 0.19, 0.5, 0.21, 0.16, 0.2, 0.23], 0.42),
    text(P.x + 22, 590, "Flagged moments", { size: 17, weight: 700, font: HEAD, fill: T.ink }),
    pill(P.x + 22, 606, "▶ 0:11.5–0:13.4", { size: 14 }), pill(P.x + 182, 606, "▶ 0:24.9–0:26.9", { size: 14 }),

    rect(P.x, 700, P.w, 74, { r: 12, fill: T.surface, so: 0.1 }),
    text(P.x + 22, 730, "Saving to history…", { size: 17, fill: T.muted }),
    text(P.x + 22, 756, "Shown while the save request runs", { size: 15, fill: T.muted }),

    rect(P.x, 850, P.w, 74, { r: 12, fill: T.ok, fo: 0.1, stroke: T.ok, so: 0.5 }),
    text(P.x + 22, 880, "✓ Saved to history.", { size: 17, weight: 600, fill: T.ink }),
    text(P.x + 22, 906, "Added to the History list", { size: 15, fill: T.ink2 }),

    rect(P.x, 934, P.w, 92, { r: 12, fill: T.warnBg, stroke: T.warnInk, so: 0.25 }),
    text(P.x + 22, 962, [["⚠ Not saved.", { weight: 700 }], [" Results stay on screen.", {}]], { size: 16, fill: T.warnInk }),
    rect(P.x + 22, 978, 170, 32, { r: 8, fill: T.surface, stroke: T.axis, so: 1 }),
    text(P.x + 107, 999, "Try saving again", { size: 15, weight: 600, fill: T.ink, anchor: "middle" }),
    text(P.x + 206, 999, "re-sends the same save", { size: 14, fill: T.warnInk }),
    arrow([[1400 + 6, 998], [P.x - 6, 994]], { style: "warn" }),
  ];
  return page({
    num: "03 Analysis and save sequence",
    title: "Analysis and save sequence",
    subtitle: "Scoring and saving are separate requests. A failed save never hides the analysis; the result stays and can be saved again.",
    legendItems: legendWithout("key", "decision"),
    footnote: "Source: 03_app/src/App.tsx, history.ts · 03_app/worker",
    body: body.join("\n"),
  });
}

// ---------------------------------------------------------------------------------------------
// 4. Reopen a saved analysis
// ---------------------------------------------------------------------------------------------
function reopenSaved() {
  const L = 150, Bx = 430, Wx = 720, Dx = 1010, top = 180, bottom = 1036;
  const P = { x: 1210, w: 638 };
  const note = (x, y, lines, tone = "default", w = 254) => node({ x: x + 14, y, w, h: 28 + lines.length * 24, body: lines, tone, bodySize: 16 });
  const cx = P.x + P.w / 2;
  const body = [
    timeAxis(40, 262, 1030),
    lifeline(L, "Actor", "Site lead", top, bottom),
    lifeline(Bx, "User’s device", "Browser app", top, bottom),
    lifeline(Wx, "Cloudflare", "Worker", top, bottom),
    lifeline(Dx, "Cloudflare", "D1", top, bottom),

    divider(72, 274, 1078, "Load the overview · when the app opens"),
    msg(Bx, Wx, 314, "GET /api/history?limit=20", { label2: "session cookie" }),
    note(Wx, 326, ["Verify session", "Owner = shared-team"], "protected"),
    msg(Wx, Dx, 440, "newest 20 shared rows"),
    msg(Dx, Wx, 480, "rows", { style: "res" }),
    msg(Wx, Bx, 520, "date · duration · flagged count", { style: "res" }),
    msg(Bx, L, 560, "History list", { style: "res" }),

    divider(72, 606, 1078, "Open one saved analysis"),
    msg(L, Bx, 640, "Select a row"),
    msg(Bx, Wx, 680, "GET /api/history/<id>"),
    msg(Wx, Dx, 720, "row with this ID and owner"),
    frag(72, 740, 1078, 296, [
      { y: 740, guard: "[found]", tone: "ok" },
      { y: 940, guard: "[not found, or not in the shared History]", tone: "err" },
    ]),
    msg(Dx, Wx, 774, "row", { style: "res" }),
    msg(Wx, Bx, 808, "200 · summary + window scores", { style: "res" }),
    msg(Bx, L, 842, "Saved analysis view", { style: "res" }),
    note(Bx, 854, ["Timeline and flagged times", "No skeleton or quality checks"], "default"),
    msg(Wx, Bx, 990, "404 · no matching row", { style: "err" }),
    msg(Bx, L, 1024, "“Could not open” · row removed", { style: "err" }),

    // Optional local replay
    eyebrow(P.x, 274, "Optional · replay a flagged moment"),
    node({ x: cx - 160, y: 294, w: 320, h: 58, r: 29, tone: "start", title: "Saved analysis is open", center: true, titleSize: 19 }),
    arrow([[cx, 352], [cx, 376]]),
    diamond(cx, 432, 300, 108, ["Original video still", "on this device?"]),
    arrow([[cx + 150, 432], [cx + 180, 432], [cx + 180, 498]], { label: "Yes", at: [cx + 194, 474], anchor: "start" }),
    arrow([[cx - 150, 432], [cx - 180, 432], [cx - 180, 498]], { style: "warn", label: "No", at: [cx - 194, 474], anchor: "end" }),
    node({ x: P.x + P.w - 306, y: 500, w: 306, h: 134, tone: "privacy", title: "Open the local video", body: ["Played in this browser only", "Not uploaded or re-analysed", "No skeleton is drawn"] }),
    arrow([[P.x + P.w - 153, 634], [P.x + P.w - 153, 660]]),
    node({ x: P.x + P.w - 306, y: 662, w: 306, h: 84, title: "▶ Jump to a flagged time", titleSize: 19, body: ["Plays from its start time"] }),
    node({ x: P.x, y: 500, w: 306, h: 134, tone: "warn", title: "Times stay visible", body: ["Flagged start–end times", "and scores are listed;", "play buttons are disabled"] }),

    // What History stores
    rect(P.x, 776, P.w, 262, { r: 14, fill: T.surface, so: 0.1 }),
    text(P.x + 22, 812, "What History stores", { size: 21, weight: 700, font: HEAD, fill: T.ink }),
    eyebrow(P.x + 22, 848, "Stored per analysis"),
    ...["Date, duration, model, threshold", "Window count, flagged count and share", "Interpretation and posture summary", "Per window: start–end time, score, flag"]
      .map((s, i) => text(P.x + 22, 878 + i * 26, [["✓ ", { fill: T.ok, weight: 700 }], [s, {}]], { size: 16, fill: T.ink2 })),
    eyebrow(P.x + 418, 848, "Never stored"),
    ...["Video", "Keypoints", "File names"]
      .map((s, i) => text(P.x + 418, 878 + i * 26, [["✕ ", { fill: T.err, weight: 700 }], [s, {}]], { size: 16, fill: T.ink2 })),
    text(P.x + 22, 1016, "The team’s shared History keeps the newest 100 records.", { size: 15, fill: T.muted }),
  ];
  return page({
    num: "04 Reopen a saved analysis",
    title: "Reopen a saved analysis",
    subtitle: "History returns summaries and window scores from the team’s shared History. Replaying a moment needs the original video on this device.",
    legendItems: legendWithout("key"),
    footnote: "Source: 03_app/src/App.tsx, history.ts · 03_app/worker/history.ts",
    body: body.join("\n"),
  });
}

export const DIAGRAMS = {
  "system-architecture": systemArchitecture,
  "supervisor-user-flow": supervisorFlow,
  "analysis-and-save-sequence": analysisAndSave,
  "reopen-saved-analysis": reopenSaved,
};
