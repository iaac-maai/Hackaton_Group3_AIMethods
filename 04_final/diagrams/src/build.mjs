// Builds the Motion Atlas diagrams: writes ../<name>.svg and, unless --svg-only, ../<name>.png (2×, 3840 × 2160).
//
//   node 04_final/diagrams/src/build.mjs            # from the repository root
//   node 04_final/diagrams/src/build.mjs --svg-only
//
// PNG export renders each SVG in headless Microsoft Edge through playwright-core, which is already a
// dev dependency of 03_app (run `npm install` in 03_app first). Pass --channel chrome to use Chrome.
// Inter and Mulish (SIL Open Font License) are loaded from ./fonts so the PNGs match the app's type.
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIAGRAMS } from "./diagrams.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..");
const args = process.argv.slice(2);
const channel = args.includes("--channel") ? args[args.indexOf("--channel") + 1] : "msedge";

const svgs = {};
for (const [name, build] of Object.entries(DIAGRAMS)) {
  svgs[name] = build();
  writeFileSync(join(out, `${name}.svg`), svgs[name]);
  console.log(`wrote ${name}.svg`);
}

if (!args.includes("--svg-only")) {
  const require = createRequire(join(here, "../../../03_app/package.json"));
  const { chromium } = require("playwright-core");
  const font = (family, file, weights) =>
    `@font-face{font-family:'${family}';font-weight:${weights};font-style:normal;src:url('${pathToFileURL(join(here, "fonts", file))}') format('woff2');}`;
  const browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  for (const name of Object.keys(svgs)) {
    const html = `<!doctype html><meta charset="utf-8"><style>${font("Inter", "inter.woff2", "100 900")}${font("Mulish", "mulish.woff2", "200 1000")}
      html,body{margin:0;background:#060910}svg{display:block}</style>${readFileSync(join(out, `${name}.svg`), "utf8")}`;
    const tmp = join(here, `.render-${name}.html`);
    writeFileSync(tmp, html);
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, `${name}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    (await import("node:fs")).unlinkSync(tmp);
    console.log(`wrote ${name}.png`);
  }
  await browser.close();
}
