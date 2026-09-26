#!/usr/bin/env node
/**
 * `make demo` — create two example projects so you can see what NoLaptop does
 * instead of reading about it.
 *
 *   demo-plain     an empty-ish Node app. No database, no storage.
 *   demo-services  the same idea, but wired to its own PostgreSQL database and
 *                  its own S3 bucket, both handed to it automatically.
 *
 * It talks to a running NoLaptop over its own HTTP API — the same calls the web
 * UI makes — so it also doubles as a smoke test.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.NL_URL ?? `http://localhost:${process.env.PORT ?? 4400}`;
const CLEAN = process.argv.includes("--clean");

const PROJECTS = [
  { name: "demo-plain", template: "node-basic", services: false },
  { name: "demo-services", template: "node-services", services: true },
];

// --------------------------------------------------------------- plumbing

function readEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) die("No .env found. Run `make install` first.");
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

let cookie = "";

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(body.error ?? `${pathname} failed (${res.status})`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(text) {
  process.stdout.write(`  ${text}\n`);
}

// ------------------------------------------------------------------- main

const env = readEnv();

try {
  await fetch(`${BASE}/api/status`);
} catch {
  die(`NoLaptop is not answering on ${BASE}. Start it with \`make dev\` or \`make start\`.`);
}

await api("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ password: env.NL_APP_PASSWORD }),
});

const { servers } = await api("/api/servers");
if (servers.length === 0) {
  die("No servers configured yet. Add one in the web UI first — it needs tmux and the claude CLI.");
}

const server = servers.find((s) => s.status === "ONLINE" && s.active) ?? servers[0];
if (server.status !== "ONLINE") {
  die(`Server "${server.name}" is ${server.status.toLowerCase()}. Fix that first.`);
}

// --------------------------------------------------------------- clean up

if (CLEAN) {
  console.log(`\nRemoving the demo projects from ${server.name}\n`);
  const { sessions } = await api("/api/sessions");
  for (const project of PROJECTS) {
    const session = sessions.find((s) => s.projectName === project.name);
    if (!session) {
      step(`${project.name}: nothing to remove`);
      continue;
    }
    const { allocations } = await api(`/api/sessions/${session.id}/resources`);
    for (const allocation of allocations) {
      await api(
        `/api/sessions/${session.id}/resources?allocationId=${allocation.id}&destroy=1`,
        { method: "DELETE" },
      );
      step(`${project.name}: dropped ${allocation.namespace}`);
    }
    await api(`/api/sessions/${session.id}?stop=1`, { method: "DELETE" });
    step(`${project.name}: session stopped and removed`);
  }
  console.log(`\n  The project folders themselves are left on the server.\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ create

console.log(`\nCreating two demo projects on ${server.name} (${server.projectRoot})\n`);

const { resources } = await api("/api/resources");
const usable = resources.filter((r) => r.active && r.status === "ONLINE");
const haveServices = usable.some((r) => r.kind === "POSTGRES") && usable.some((r) => r.kind === "S3");

if (!haveServices) {
  step("No shared database and storage are active yet.");
  step(`Enable them on the "${server.name}" card under Servers, then run this again`);
  step("to get the second project too. Continuing with the plain one.\n");
}

const created = [];

for (const project of PROJECTS) {
  if (project.services && !haveServices) continue;

  const resourceIds = project.services ? usable.map((r) => r.id) : [];
  step(`${project.name}: creating…`);

  let session;
  try {
    ({ session } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        serverId: server.id,
        projectName: project.name,
        template: project.template,
        resourceIds,
      }),
    }));
  } catch (err) {
    step(`${project.name}: ${err.message}`);
    continue;
  }

  // Wait for Remote Control and the starter app.
  let final = session;
  for (let i = 0; i < 40; i += 1) {
    await sleep(5000);
    const { sessions } = await api("/api/sessions");
    final = sessions.find((s) => s.id === session.id) ?? final;
    const settled =
      final.state === "REMOTE_CONNECTED" &&
      (final.appState === "RUNNING" || final.appState === "FAILED" || final.appState === "NONE");
    if (settled) break;
  }
  created.push(final);

  step(`${project.name}: ${final.state}`);
  if (final.remoteUrl) step(`${project.name}: ${final.remoteUrl}`);
  if (final.appUrl) step(`${project.name}: app on ${final.appUrl}`);
  if (final.appState === "FAILED") step(`${project.name}: app failed — ${final.appDetail ?? ""}`);
  process.stdout.write("\n");
}

// ---------------------------------------------------------------- what now

console.log("Done. Here is what just happened:\n");
for (const session of created) {
  console.log(`  ${session.projectName}`);
  console.log(`    folder        ${session.projectPath}`);
  console.log(`    tmux          ${session.tmuxSession}`);
  console.log(`    dev port      ${session.devPort ?? "not reserved"}`);
  if (session.resources?.length) {
    for (const r of session.resources) {
      console.log(`    ${r.kind === "POSTGRES" ? "database     " : "bucket       "} ${r.namespace}`);
    }
  } else {
    console.log(`    services      none`);
  }
  console.log(`    open Claude   ${session.remoteUrl ?? "pending"}`);
  if (session.appUrl) console.log(`    open the app  ${session.appUrl}`);
  console.log("");
}

console.log(`  Open ${BASE} on your phone to drive them.`);
console.log(`  Remove all of this again with:  make demo-clean\n`);
