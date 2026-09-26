#!/usr/bin/env node
/**
 * Render terminal output as an image.
 *
 * Used to put real command output into the README and articles without
 * photographing a terminal window. The input is the actual captured output —
 * this only styles it.
 *
 *   node scripts/render-terminal.mjs <input.txt> <output.png> "Title"
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [input, output, title = ""] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: render-terminal.mjs <input.txt> <output.png> [title]");
  process.exit(1);
}

const EXECUTABLE =
  process.env.NL_CHROMIUM ??
  "/home/oliver/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const text = fs.readFileSync(input, "utf8").replace(/\s+$/, "");

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Light syntax colouring, matched to what these commands actually print. */
function colour(line) {
  const e = escapeHtml(line);
  if (/^\s*✓/.test(line)) return `<span class="ok">${e}</span>`;
  if (/^\s*[!⚠]/.test(line)) return `<span class="warn">${e}</span>`;
  if (/^\s*✗/.test(line)) return `<span class="bad">${e}</span>`;
  if (/^\s*[$#]\s/.test(line)) return `<span class="cmd">${e}</span>`;
  if (/^\s*#/.test(line)) return `<span class="dim">${e}</span>`;
  if (/^\s*[┌├└│]/.test(line)) return `<span class="box">${e}</span>`;
  if (/^\s*(🚀|Result:|Ready\.)/.test(line)) return `<span class="hi">${e}</span>`;
  if (/^\s*[a-z-]+:\s/.test(line) && line.includes("http")) return `<span class="url">${e}</span>`;
  return e;
}

const body = text.split("\n").map(colour).join("\n");

const html = `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body { background: transparent; font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; }
  .window { width: 920px; border-radius: 12px; overflow: hidden;
            border: 1px solid #2a2d33; background: #0d0e10;
            box-shadow: 0 18px 50px rgba(0,0,0,.45); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
         background: #17191d; border-bottom: 1px solid #2a2d33; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .t { font-size: 12px; color: #8b93a1; margin-left: 8px;
       font-family: ui-sans-serif, system-ui, sans-serif; }
  pre { padding: 18px 20px 22px; font-size: 13px; line-height: 1.62;
        color: #d5d9e0; white-space: pre-wrap; word-break: break-word; }
  .ok { color: #5fdb9b; } .warn { color: #f0c34e; } .bad { color: #f38e86; }
  .cmd { color: #d97757; font-weight: 600; } .dim { color: #6b7280; }
  .box { color: #78b3f0; } .hi { color: #edeff2; font-weight: 600; }
  .url { color: #78b3f0; }
</style>
<div class="window">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="t">${escapeHtml(title)}</span>
  </div>
  <pre>${body}</pre>
</div>`;

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "domcontentloaded" });
fs.mkdirSync(path.dirname(output), { recursive: true });
await page.locator(".window").screenshot({ path: output, omitBackground: true });
await browser.close();
console.log(`  ${path.basename(output)}`);
