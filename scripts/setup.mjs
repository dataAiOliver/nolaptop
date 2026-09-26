#!/usr/bin/env node
/**
 * First-run setup: generate the two secrets NoLaptop refuses to start without.
 *
 * This app holds SSH keys for every server you add, so it will not serve
 * anything until both are set. Running this twice is safe — existing values are
 * kept, because regenerating the encryption key would make every stored SSH key
 * unreadable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

// `--quiet` is used by the pre-start hook: say nothing unless something was
// actually generated, so a normal start is not noisy.
const quiet = process.argv.includes("--quiet");

const DEFAULTS = {
  DATABASE_URL: "file:./data/nolaptop.db",
  NL_ENCRYPTION_KEY: () => crypto.randomBytes(48).toString("base64"),
  NL_APP_PASSWORD: () => crypto.randomBytes(12).toString("base64url"),
  NL_MONITOR_INTERVAL_MS: "15000",
};

function parseEnv(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

const existing = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : new Map();

const generated = [];
const values = new Map(existing);

for (const [key, fallback] of Object.entries(DEFAULTS)) {
  const current = values.get(key);
  if (current && current.length > 0) continue;
  const value = typeof fallback === "function" ? fallback() : fallback;
  values.set(key, value);
  if (typeof fallback === "function") generated.push(key);
}

const lines = [
  "# NoLaptop configuration. Keep this file private — it is git-ignored.",
  "",
  "# SQLite database file, relative to the project root.",
  `DATABASE_URL="${values.get("DATABASE_URL")}"`,
  "",
  "# Encrypts SSH keys and service credentials at rest (AES-256-GCM).",
  "# Changing this makes every stored credential unreadable.",
  `NL_ENCRYPTION_KEY="${values.get("NL_ENCRYPTION_KEY")}"`,
  "",
  "# Password for the web UI. Required — the app will not serve without it.",
  `NL_APP_PASSWORD="${values.get("NL_APP_PASSWORD")}"`,
  "",
  "# How often the health monitor re-checks servers and sessions, in ms.",
  `NL_MONITOR_INTERVAL_MS="${values.get("NL_MONITOR_INTERVAL_MS")}"`,
  "",
];

if (quiet && generated.length === 0) {
  // Nothing to do and nothing to say.
  process.exit(0);
}

fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
fs.chmodSync(envPath, 0o600);

if (generated.includes("NL_APP_PASSWORD")) {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │  NoLaptop password — shown once             │");
  console.log("  ├─────────────────────────────────────────────┤");
  console.log(`  │  ${values.get("NL_APP_PASSWORD").padEnd(43)}│`);
  console.log("  └─────────────────────────────────────────────┘");
  console.log("");
  console.log(`  It is also in ${path.relative(process.cwd(), envPath)}, which is git-ignored.`);
  console.log("");
} else if (!quiet) {
  console.log(`Wrote ${path.relative(process.cwd(), envPath)} (mode 600). Existing secrets were kept.`);
} else if (generated.length > 0) {
  console.log(`Generated ${generated.join(", ")} into ${path.relative(process.cwd(), envPath)}.`);
}
