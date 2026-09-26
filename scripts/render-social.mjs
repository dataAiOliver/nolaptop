#!/usr/bin/env node
/**
 * Render the social preview image.
 *
 *   node scripts/render-social.mjs <phone-screenshot.png> <output.png> [square]
 *
 * Kept in the repo so the card can be regenerated whenever the app's look
 * changes, rather than becoming a picture of a version nobody runs any more.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const [shot, output, shape = "wide"] = process.argv.slice(2);
if (!shot || !output) {
  console.error("usage: render-social.mjs <phone.png> <out.png> [wide|square]");
  process.exit(1);
}

/**
 * Find a Chromium to render with.
 *
 * Hard-coding a Playwright cache path breaks the moment the browser updates —
 * and it would never have worked on anyone else's machine.
 */
function findChromium() {
  if (process.env.NL_CHROMIUM) return process.env.NL_CHROMIUM;

  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cache)) {
    const builds = fs
      .readdirSync(cache)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(cache, build, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  for (const system of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(system)) return system;
  }
  throw new Error("No Chromium found. Set NL_CHROMIUM to one, or run: npx playwright install chromium");
}

const EXECUTABLE = findChromium();

const size = shape === "square" ? { width: 1200, height: 1200 } : { width: 1200, height: 630 };
const phone = `data:image/png;base64,${fs.readFileSync(shot).toString("base64")}`;

const html = `<!doctype html><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap');
  * { margin: 0; box-sizing: border-box; }
  body { width: ${size.width}px; height: ${size.height}px; overflow: hidden;
         background: radial-gradient(120% 140% at 12% 0%, #1d1a19 0%, #101113 55%, #0b0c0d 100%);
         font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #edeff2;
         display: flex; align-items: center; gap: ${shape === "square" ? "0" : "56px"};
         flex-direction: ${shape === "square" ? "column" : "row"};
         padding: ${shape === "square" ? "64px 72px 0" : "0 0 0 72px"};
         position: relative; }
  /* a warm bloom behind the device, so it does not float on flat black */
  body::after { content: ""; position: absolute; right: ${shape === "square" ? "50%" : "16%"};
                top: ${shape === "square" ? "62%" : "50%"};
                transform: translate(50%, -50%); width: 620px; height: 620px;
                background: radial-gradient(circle, rgba(217,119,87,.22) 0%, transparent 62%);
                pointer-events: none; }
  .copy { flex: ${shape === "square" ? "0 0 auto" : "1"}; position: relative; z-index: 2;
          text-align: ${shape === "square" ? "center" : "left"}; }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 30px;
           justify-content: ${shape === "square" ? "center" : "flex-start"}; }
  .mark { width: 46px; height: 46px; border-radius: 12px; background: #d97757;
          color: #1a0f0a; font-weight: 700; font-size: 18px;
          display: grid; place-items: center; }
  .name { font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
  h1 { font-size: ${shape === "square" ? "58px" : "54px"}; line-height: 1.08;
       letter-spacing: -.028em; font-weight: 700; }
  h1 em { font-style: normal; color: #d97757; }
  p { margin-top: 22px; font-size: ${shape === "square" ? "25px" : "23px"};
      line-height: 1.5; color: #9ca3af; max-width: 19em;
      margin-left: ${shape === "square" ? "auto" : "0"};
      margin-right: ${shape === "square" ? "auto" : "0"}; }
  .repo { margin-top: 34px; font-size: 19px; color: #6b7280;
          font-family: ui-monospace, Menlo, monospace; }
  .stage { flex: ${shape === "square" ? "1 1 auto" : "0 0 470px"}; position: relative; z-index: 2;
           height: 100%; display: flex; align-items: center;
           justify-content: center; padding: ${shape === "square" ? "34px 0 0" : "0"};
           overflow: hidden; }
  .device { width: ${shape === "square" ? "340px" : "296px"};
            border-radius: 34px; border: 9px solid #1c1e22; background: #000;
            box-shadow: 0 40px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05);
            overflow: hidden; transform: rotate(${shape === "square" ? "0deg" : "-3deg"}); }
  .device img { width: 100%; display: block; }
</style>
<div class="copy">
  <div class="brand"><span class="mark">NL</span><span class="name">NoLaptop</span></div>
  <h1>Coding-Agent starten.<br><em>Vom Handy.</em></h1>
  <p>Projektordner, eigene Datenbank, eigener Bucket, freier Port — und Claude Code läuft.</p>
  <div class="repo">github.com/dataAiOliver/nolaptop</div>
</div>
<div class="stage"><div class="device"><img src="${phone}"></div></div>`;

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
fs.mkdirSync(path.dirname(output), { recursive: true });
await page.screenshot({ path: output });
await browser.close();
console.log(`  ${path.basename(output)}  ${size.width}×${size.height}`);
