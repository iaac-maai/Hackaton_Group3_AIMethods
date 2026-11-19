// Drawing helpers for the Motion Atlas diagrams. Every shape is written with inline attributes
// (no <style> block) so the SVGs import cleanly into Figma, Inkscape, Illustrator and PowerPoint.

// Design tokens copied from 03_app/src/styles.css (the app's current dark theme).
export const T = {
  page: "#060910", card: "#0c0f15", surface: "#101319", surface2: "#161a21",
  ink: "#ffffff", ink2: "#c7c7cc", muted: "#9e9e9e",
  grid: "#1d2129", axis: "#2e333d",
  accent: "#f66f14", accentSoft: "#ff8a3d", brand2: "#ff9b45",
  warnBg: "#2a1d08", warnInk: "#f6c67a", err: "#ff8a80", errBg: "#2c1213",
  ok: "#3aa585", custom: "#b9a7ff", customBg: "#241f3a", bar: "#8a92a6", threshold: "#e4e4e8",
};
export const HEAD = "Mulish, 'Segoe UI', system-ui, sans-serif";
export const BODY = "Inter, 'Segoe UI', system-ui, sans-serif";

export const W = 1920, H = 1080;
const LH = 24;          // body line height
const PAD = 22;         // inner left padding of nodes

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => `${k}="${v}"`).join(" ");

/** Rough text width for Inter/Mulish (used only to size pills and label backgrounds). */
export const textWidth = (s, size, weight = 400) => [...String(s)].reduce((w, ch) => {
  const k = /[il.,:;'’|!·]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.86 : /[A-Z]/.test(ch) ? 0.66 : ch === " " ? 0.28 : /[0-9]/.test(ch) ? 0.58 : 0.54;
  return w + k * size;
}, 0) * (weight >= 600 ? 1.05 : 1);

/** Text. `s` may be a string or an array of [text, {fill, weight}] segments. */
export function text(x, y, s, o = {}) {
  const { size = 17, weight = 400, fill = T.ink2, anchor = "start", font = BODY, ls, opacity, halo } = o;
  const body = Array.isArray(s)
    ? s.map(([t, so = {}]) => `<tspan ${attrs({ fill: so.fill, "font-weight": so.weight })}>${esc(t)}</tspan>`).join("")
    : esc(s);
  const haloAttrs = halo ? { stroke: halo, "stroke-width": 7, "stroke-linejoin": "round", "paint-order": "stroke" } : {};
  return `<text ${attrs({ x, y, "font-family": font, "font-size": size, "font-weight": weight, fill, "text-anchor": anchor, "letter-spacing": ls, opacity, ...haloAttrs })}>${body}</text>`;
}

export const eyebrow = (x, y, s, o = {}) => text(x, y, s.toUpperCase(), { size: 14, weight: 700, fill: T.accentSoft, ls: 1.4, ...o });

export function rect(x, y, w, h, o = {}) {
  const { r = 14, fill = T.surface, stroke = T.ink, so = 0.1, sw = 1, dash, opacity, fo } = o;
  return `<rect ${attrs({ x, y, width: w, height: h, rx: r, fill, "fill-opacity": fo, stroke: stroke || "none", "stroke-opacity": stroke ? so : null, "stroke-width": stroke ? sw : null, "stroke-dasharray": dash, opacity })}/>`;
}

// Node tones. "protected" = orange left edge (route that needs a session); "key" = review path.
const TONES = {
  default: { fill: T.surface, stroke: T.ink, so: 0.1, title: T.ink, body: T.ink2 },
  protected: { fill: T.surface, stroke: T.ink, so: 0.1, title: T.ink, body: T.ink2, edge: T.accent },
  key: { fill: T.surface, stroke: T.accent, so: 0.55, title: T.ink, body: T.ink2, edge: T.accent },
  warn: { fill: T.warnBg, stroke: T.warnInk, so: 0.22, title: T.warnInk, body: T.warnInk },
  err: { fill: T.errBg, stroke: T.err, so: 0.3, title: T.err, body: T.err },
  ok: { fill: T.ok, fo: 0.1, stroke: T.ok, so: 0.5, title: T.ink, body: T.ink2 },
  privacy: { fill: T.accent, fo: 0.1, stroke: T.accent, so: 0.55, title: T.ink, body: T.ink2 },
  ghost: { fill: "none", stroke: T.ink, so: 0.22, dash: "6 6", title: T.ink2, body: T.muted },
  start: { fill: T.surface2, stroke: T.ink, so: 0.18, title: T.ink, body: T.ink2 },
};

/** A box with an optional kicker, title and body lines. */
export function node({ x, y, w, h, title, body = [], tone = "default", kicker, r = 14, center = false, titleSize = 21, bodySize = 17 }) {
  const t = TONES[tone];
  const out = [rect(x, y, w, h, { r, fill: t.fill, fo: t.fo, stroke: t.stroke, so: t.so, dash: t.dash })];
  if (t.edge) out.push(`<rect ${attrs({ x: x + 1, y: y + 14, width: 4, height: h - 28, rx: 2, fill: t.edge })}/>`);
  const tx = center ? x + w / 2 : x + PAD + (t.edge ? 4 : 0);
  const anchor = center ? "middle" : "start";
  let cy = y;
  if (kicker) { cy += 30; out.push(eyebrow(tx, cy, kicker, { anchor })); }
  if (title) { cy += kicker ? 30 : 34; out.push(text(tx, cy, title, { size: titleSize, weight: 700, font: HEAD, fill: t.title, anchor })); }
  cy += title || kicker ? (title ? 28 : 26) : 28;
  body.forEach((line, i) => out.push(text(tx, cy + i * LH, line, { size: bodySize, fill: t.body, anchor })));
  return `<g>${out.join("")}</g>`;
}

/** Large container ("zone") for a system boundary. */
export function zone({ x, y, w, h, kicker, title, sub }) {
  return `<g>${rect(x, y, w, h, { r: 20, fill: T.card, so: 0.09 })}${eyebrow(x + 24, y + 38, kicker)}`
    + `${text(x + 24, y + 70, title, { size: 25, weight: 800, font: HEAD, fill: T.ink })}`
    + (sub ? text(x + 24, y + 96, sub, { size: 16, fill: T.muted }) : "") + `</g>`;
}

export function pill(x, y, s, o = {}) {
  const { tone = "default", size = 15, anchor = "start" } = o;
  const c = {
    default: [T.grid, T.ink2, null], accent: [T.accent, T.ink, null], privacy: [T.accent, T.ink, 0.16],
    warn: [T.warnBg, T.warnInk, null], ok: [T.ok, T.ink, 0.16], custom: [T.customBg, T.custom, null], err: [T.errBg, T.err, null],
  }[tone];
  const w = textWidth(s, size, 600) + 26, h = size + 15;
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return `<g>${rect(left, y, w, h, { r: h / 2, fill: c[0], fo: c[2], stroke: tone === "privacy" || tone === "ok" ? c[0] : null, so: 0.6 })}`
    + text(left + w / 2, y + h / 2 + size * 0.36, s, { size, weight: 600, fill: c[1], anchor: "middle" }) + `</g>`;
}

// Line styles shared by all diagrams.
export const LINE = {
  req: { stroke: T.ink2, sw: 2 },
  res: { stroke: T.bar, sw: 2, dash: "8 6" },
  key: { stroke: T.accent, sw: 2.5 },
  warn: { stroke: T.warnInk, sw: 2, dash: "8 6" },
  warnSolid: { stroke: T.warnInk, sw: 2 },
  err: { stroke: T.err, sw: 2, dash: "8 6" },
  plain: { stroke: T.axis, sw: 2 },
  time: { stroke: T.muted, sw: 2 },
};

/** Vertical time axis for sequence diagrams: starts with a dot, ends with an arrow, labelled "Time" reading downward. */
export function timeAxis(x, y0, y1) {
  const s = LINE.time;
  return `<g id="time-axis"><circle cx="${x}" cy="${y0}" r="4" fill="${s.stroke}"/>`
    + `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${s.stroke}" stroke-width="${s.sw}" marker-end="url(#ah-time)"/>`
    + `<text x="${x - 14}" y="${y0 + 14}" transform="rotate(90 ${x - 14} ${y0 + 14})" font-family="${BODY}" font-size="15" font-weight="700" letter-spacing="1.6" fill="${T.ink2}">TIME</text>`
    + `<text x="${x - 14}" y="${y1 - 64}" transform="rotate(90 ${x - 14} ${y1 - 64})" font-family="${BODY}" font-size="15" font-weight="500" fill="${T.ink2}">later</text></g>`;
}

export function defs() {
  const marker = (id, color) => `<marker id="ah-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0.5 L10,5 L0,9.5 z" fill="${color}"/></marker>`;
  return `<defs>${Object.entries(LINE).map(([k, v]) => marker(k, v.stroke)).join("")}`
    + `<radialGradient id="glow" cx="50%" cy="0%" r="60%"><stop offset="0" stop-color="${T.accent}" stop-opacity="0.10"/><stop offset="1" stop-color="${T.accent}" stop-opacity="0"/></radialGradient></defs>`;
}

/** Polyline arrow through `pts` ([[x,y], …]). Optional label placed at `at` = [x, y]. */
export function arrow(pts, o = {}) {
  const { style = "req", label, at, anchor = "middle", label2, both = false, head = true, size = 16, halo = T.page, lfill } = o;
  const s = LINE[style];
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const out = [`<path ${attrs({ d, fill: "none", stroke: s.stroke, "stroke-width": s.sw, "stroke-dasharray": s.dash, "stroke-linejoin": "round", "marker-end": head ? `url(#ah-${style})` : null, "marker-start": both ? `url(#ah-${style})` : null })}/>`];
  if (label && at) out.push(text(at[0], at[1], label, { size, weight: 500, fill: lfill ?? (style === "warn" || style === "warnSolid" ? T.warnInk : style === "err" ? T.err : style === "key" ? T.accentSoft : T.ink2), anchor, halo }));
  if (label2 && at) out.push(text(at[0], at[1] + 22, label2, { size: size - 1, fill: T.muted, anchor, halo }));
  return `<g>${out.join("")}</g>`;
}

export function diamond(cx, cy, w, h, lines, o = {}) {
  const { stroke = T.brand2 } = o;
  const pts = `${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`;
  const y0 = cy - ((lines.length - 1) * 23) / 2 + 6;
  return `<g><polygon points="${pts}" fill="${T.surface2}" stroke="${stroke}" stroke-opacity="0.75" stroke-width="1.5" stroke-linejoin="round"/>`
    + lines.map((l, i) => text(cx, y0 + i * 23, l, { size: 18, weight: 700, font: HEAD, fill: T.ink, anchor: "middle" })).join("") + `</g>`;
}

export const dot = (x, y, color = T.ink2) => `<circle cx="${x}" cy="${y}" r="4.5" fill="${color}"/>`;

// ---------- sequence-diagram helpers ----------
export function lifeline(x, kicker, title, y0, y1, o = {}) {
  const { w = 230 } = o;
  return `<g><line x1="${x}" y1="${y0 + 60}" x2="${x}" y2="${y1}" stroke="${T.axis}" stroke-width="2" stroke-dasharray="3 6"/>`
    + rect(x - w / 2, y0, w, 60, { r: 14, fill: T.surface2, so: 0.14 })
    + eyebrow(x, y0 + 23, kicker, { anchor: "middle", size: 12 })
    + text(x, y0 + 47, title, { size: 20, weight: 800, font: HEAD, fill: T.ink, anchor: "middle" }) + `</g>`;
}

/** Horizontal message between lifelines. Label sits above the line, label2 below it. */
export function msg(x1, x2, y, label, o = {}) {
  const { style = "req", label2, labelX } = o;
  const dir = Math.sign(x2 - x1);
  return arrow([[x1 + dir * 6, y], [x2 - dir * 6, y]], { style, label, at: [labelX ?? (x1 + x2) / 2, y - 10], label2: null })
    + (label2 ? text(labelX ?? (x1 + x2) / 2, y + 22, label2, { size: 15, fill: T.muted, anchor: "middle", halo: T.page }) : "");
}

/** Section divider across the sequence: eyebrow label + hairline. */
export function divider(x, y, w, label) {
  const tw = textWidth(label.toUpperCase(), 14, 700) + label.length * 1.4 + 16;
  return `<g><line x1="${x + tw}" y1="${y - 5}" x2="${x + w}" y2="${y - 5}" stroke="${T.ink}" stroke-opacity="0.1" stroke-width="1"/>${eyebrow(x, y, label, { halo: T.page })}</g>`;
}

/** UML-style combined fragment ("alt") with stacked sections [{y, guard, tone}]. */
export function frag(x, y, w, h, sections) {
  const out = [rect(x, y, w, h, { r: 12, fill: "none", so: 0.22 })];
  out.push(`<path d="M${x},${y + 28} H${x + 46} L${x + 56},${y + 18} V${y}" fill="none" stroke="${T.ink}" stroke-opacity="0.22"/>`);
  out.push(text(x + 12, y + 20, "alt", { size: 14, weight: 700, fill: T.ink2 }));
  sections.forEach((s, i) => {
    if (i > 0) out.push(`<line x1="${x}" y1="${s.y}" x2="${x + w}" y2="${s.y}" stroke="${T.ink}" stroke-opacity="0.22" stroke-dasharray="6 5"/>`);
    out.push(text(x + 70, s.y + (i ? 24 : 21), s.guard, { size: 15, weight: 600, fill: s.tone === "warn" ? T.warnInk : s.tone === "ok" ? "#7fd3b8" : s.tone === "err" ? T.err : T.ink2 }));
  });
  return `<g>${out.join("")}</g>`;
}

// ---------- page frame ----------
export function legend(x, y, items) {
  let cx = x;
  const out = [];
  for (const it of items) {
    if (it.line) {
      const s = LINE[it.line];
      out.push(`<line x1="${cx}" y1="${y - 5}" x2="${cx + 38}" y2="${y - 5}" stroke="${s.stroke}" stroke-width="${s.sw}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} marker-end="url(#ah-${it.line})"/>`);
      cx += 50;
    } else if (it.edge) {
      out.push(rect(cx, y - 17, 26, 24, { r: 6, fill: T.surface, so: 0.15 }), `<rect x="${cx + 1}" y="${y - 13}" width="4" height="16" rx="2" fill="${T.accent}"/>`);
      cx += 36;
    } else if (it.box) {
      const t = TONES[it.box];
      out.push(rect(cx, y - 17, 26, 24, { r: 6, fill: t.fill, fo: t.fo, stroke: t.stroke, so: Math.max(t.so, 0.3), dash: t.dash }));
      cx += 36;
    } else if (it.diamond) {
      out.push(`<polygon points="${cx + 13},${y - 19} ${cx + 27},${y - 5} ${cx + 13},${y + 9} ${cx - 1},${y - 5}" fill="${T.surface2}" stroke="${T.brand2}" stroke-width="1.5"/>`);
      cx += 38;
    }
    out.push(text(cx, y, it.label, { size: 15, fill: T.ink2 }));
    cx += textWidth(it.label, 15) + 34;
  }
  return `<g>${out.join("")}</g>`;
}

export function page({ num, title, subtitle, legendItems, footnote, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${BODY}">
<title>Motion Atlas · ${esc(title)}</title>
${defs()}
<rect width="${W}" height="${H}" fill="${T.page}"/>
<rect width="${W}" height="520" fill="url(#glow)"/>
<g id="header">${eyebrow(72, 72, `Motion Atlas · ${num}`)}${text(72, 118, title, { size: 42, weight: 800, font: HEAD, fill: T.ink, ls: -0.4 })}${text(72, 154, subtitle, { size: 20, fill: T.ink2 })}</g>
<g id="diagram">${body}</g>
<g id="footer">${legend(72, 1056, legendItems)}${footnote ? text(1848, 1056, footnote, { size: 14, fill: T.muted, anchor: "end" }) : ""}</g>
</svg>
`;
}

/** Legend shared by all four diagrams so arrows read the same everywhere. */
const STANDARD_LEGEND = [
  { id: "req", line: "req", label: "Request / data sent" },
  { id: "res", line: "res", label: "Response" },
  { id: "key", line: "key", label: "Review path" },
  { id: "warn", line: "warn", label: "Failure or fallback" },
  { id: "session", edge: true, label: "Needs a logged-in session" },
  { id: "decision", diamond: true, label: "Decision" },
];
/** The standard legend minus the entries a diagram doesn't use (same order and look everywhere). */
export const legendWithout = (...ids) => STANDARD_LEGEND.filter((l) => !ids.includes(l.id));
