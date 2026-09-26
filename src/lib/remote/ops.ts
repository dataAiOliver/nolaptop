import type { Server } from "@prisma/client";
import { sshExec, type ExecResult, type SshTarget } from "../ssh";
import { isValidTmuxName, projectPathWithin, sq } from "../shell";
import { isSafeRelativePath } from "../templates";

/**
 * The complete set of things this app is allowed to do on a remote host.
 *
 * There is deliberately no "run arbitrary command" entry point reachable from
 * the API. Every function here builds its own command from validated inputs and
 * single-quotes every interpolated value.
 */

/** Claude Code installs to ~/.local/bin, which a non-login SSH shell often misses. */
const ENV_PREFIX = `export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"; `;

/** ASCII record separator, used to frame the per-file JSON blobs we cat back. */
const RS = String.fromCharCode(30);

function run(server: SshTarget, script: string, timeoutMs?: number): Promise<ExecResult> {
  return sshExec(server, ENV_PREFIX + script, { timeoutMs });
}

function assertTmux(name: string): void {
  if (!isValidTmuxName(name)) throw new Error(`Refusing to use tmux session name: ${name}`);
}

// ---------------------------------------------------------------- host facts

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
};

export type HostInfo = {
  claudeVersion: string | null;
  tmuxVersion: string | null;
  home: string | null;
  auth: ClaudeAuthStatus | null;
};

export async function getHostInfo(server: SshTarget): Promise<HostInfo> {
  const res = await run(
    server,
    [
      `echo "###HOME"; echo "$HOME"`,
      `echo "###TMUX"; tmux -V 2>/dev/null || echo ""`,
      `echo "###CLAUDE"; claude --version 2>/dev/null || echo ""`,
      `echo "###AUTH"; claude auth status --json 2>/dev/null || echo ""`,
    ].join("; "),
    25_000,
  );
  const s = splitSections(res.stdout);

  let auth: ClaudeAuthStatus | null = null;
  const authRaw = s.AUTH?.trim();
  if (authRaw) {
    try {
      const parsed = JSON.parse(authRaw) as Record<string, unknown>;
      auth = {
        loggedIn: parsed.loggedIn === true,
        authMethod: asString(parsed.authMethod),
        email: asString(parsed.email),
        subscriptionType: asString(parsed.subscriptionType),
        orgName: asString(parsed.orgName),
      };
    } catch {
      auth = null;
    }
  }

  return {
    home: s.HOME?.trim() || null,
    tmuxVersion: s.TMUX?.trim() || null,
    claudeVersion: s.CLAUDE?.trim() || null,
    auth,
  };
}

// -------------------------------------------------------------- project ops

export async function ensureProjectRoot(server: Server): Promise<void> {
  const res = await run(server, `mkdir -p ${sq(server.projectRoot)}`);
  if (res.code !== 0) {
    throw new Error(`Could not create project root ${server.projectRoot}: ${res.stderr.trim()}`);
  }
}

export async function projectExists(server: Server, projectName: string): Promise<boolean> {
  const dir = projectPathWithin(server.projectRoot, projectName);
  const res = await run(server, `[ -d ${sq(dir)} ] && echo yes || echo no`);
  return res.stdout.trim() === "yes";
}

export async function createProject(
  server: Server,
  projectName: string,
): Promise<{ path: string; created: boolean }> {
  const dir = projectPathWithin(server.projectRoot, projectName);
  await ensureProjectRoot(server);
  const res = await run(
    server,
    `if [ -d ${sq(dir)} ]; then echo existed; else mkdir -p ${sq(dir)} && echo created; fi`,
  );
  const out = res.stdout.trim();
  if (res.code !== 0 || (out !== "created" && out !== "existed")) {
    throw new Error(`Could not create project directory ${dir}: ${res.stderr.trim() || out}`);
  }
  return { path: dir, created: out === "created" };
}

export async function listProjectDirs(server: Server): Promise<string[]> {
  const res = await run(server, `ls -1 ${sq(server.projectRoot)} 2>/dev/null | head -500 || true`);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function getGitInfo(
  server: Server,
  projectPath: string,
): Promise<{ branch: string | null; commit: string | null }> {
  const res = await run(
    server,
    `cd ${sq(projectPath)} 2>/dev/null && ` +
      `echo "###BRANCH"; git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""; ` +
      `echo "###COMMIT"; git log -1 --pretty=format:'%h %s' 2>/dev/null || echo ""`,
  );
  const s = splitSections(res.stdout);
  return {
    branch: s.BRANCH?.trim() || null,
    commit: s.COMMIT?.trim().slice(0, 120) || null,
  };
}

// ------------------------------------------------------------------ tmux ops

export async function tmuxSessionExists(server: Server, tmuxName: string): Promise<boolean> {
  assertTmux(tmuxName);
  const res = await run(
    server,
    `tmux has-session -t ${sq(`=${tmuxName}`)} 2>/dev/null && echo yes || echo no`,
  );
  return res.stdout.trim() === "yes";
}

export async function listTmuxSessions(server: Server): Promise<string[]> {
  const res = await run(server, `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Create a detached tmux session running `command` inside `cwd`.
 * The session outlives our SSH connection, which is the whole point.
 */
export async function createTmuxSession(
  server: Server,
  tmuxName: string,
  cwd: string,
  command: string,
): Promise<void> {
  assertTmux(tmuxName);
  const res = await run(
    server,
    `tmux new-session -d -s ${sq(tmuxName)} -c ${sq(cwd)} -x 200 -y 50 ${sq(command)}`,
    30_000,
  );
  if (res.code !== 0) {
    throw new Error(`tmux could not start session ${tmuxName}: ${res.stderr.trim()}`);
  }
}

export async function killTmuxSession(server: Server, tmuxName: string): Promise<void> {
  assertTmux(tmuxName);
  await run(server, `tmux kill-session -t ${sq(`=${tmuxName}`)} 2>/dev/null || true`);
}

export async function captureClaudeOutput(
  server: Server,
  tmuxName: string,
  lines = 60,
): Promise<string> {
  assertTmux(tmuxName);
  const n = Math.min(Math.max(Math.trunc(lines), 5), 400);
  const res = await run(
    server,
    `tmux capture-pane -p -t ${sq(`=${tmuxName}:`)} -S ${sq(String(-n))} 2>/dev/null || true`,
  );
  return res.stdout;
}

/**
 * The only way input reaches a Claude process. Callers may send a short list of
 * named keys (for CLI dialogs) or one line of literal text — never a raw
 * key-sequence string assembled by a client.
 */
export type TmuxKey =
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Enter"
  | "Escape"
  | "Tab"
  | "y"
  | "n"
  | "1"
  | "2";

const ALLOWED_KEYS = new Set<TmuxKey>([
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Tab",
  "y",
  "n",
  "1",
  "2",
]);

export async function sendClaudeKeys(
  server: Server,
  tmuxName: string,
  keys: TmuxKey[],
): Promise<void> {
  assertTmux(tmuxName);
  if (keys.length === 0 || keys.length > 8) throw new Error("Between 1 and 8 keys may be sent.");
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Key not allowed: ${key}`);
  }
  const parts = keys.map((k) => `tmux send-keys -t ${sq(`=${tmuxName}:`)} ${sq(k)}`);
  await run(server, parts.join(" && sleep 0.4 && "), 20_000);
}

export async function sendClaudeInput(
  server: Server,
  tmuxName: string,
  text: string,
): Promise<void> {
  assertTmux(tmuxName);
  if (text.includes("\n")) throw new Error("Only a single line may be sent.");
  if (text.length > 2000) throw new Error("Input is too long.");
  // -l sends the text literally: tmux does not interpret it as key names.
  await run(
    server,
    `tmux send-keys -t ${sq(`=${tmuxName}:`)} -l ${sq(text)} && sleep 0.3 && ` +
      `tmux send-keys -t ${sq(`=${tmuxName}:`)} Enter`,
    20_000,
  );
}

/**
 * Files this app is allowed to write into a project directory.
 *
 * A closed list rather than a path argument: the point of the project root is
 * that nothing outside it can be touched, and a filename is exactly the sort of
 * thing that turns into a traversal bug when it comes from a caller.
 */
const WRITABLE_PROJECT_FILES = new Set([".env", "AGENTS.md", "CLAUDE.md"]);

export async function writeProjectFile(
  server: Server,
  projectPath: string,
  filename: string,
  content: string,
): Promise<void> {
  if (!WRITABLE_PROJECT_FILES.has(filename)) {
    throw new Error(`Refusing to write "${filename}" into a project directory.`);
  }
  if (!projectPath.startsWith(server.projectRoot + "/")) {
    throw new Error("Refusing to write outside the configured project root.");
  }
  const target = `${projectPath}/${filename}`;
  // base64 so the content never has to survive a round of shell quoting.
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const res = await run(
    server,
    `printf '%s' ${sq(encoded)} | base64 -d > ${sq(target)} && chmod 600 ${sq(target)} && echo written`,
  );
  if (res.stdout.trim() !== "written") {
    throw new Error(`Could not write ${target}: ${res.stderr.trim()}`);
  }
}

export async function readProjectFile(
  server: Server,
  projectPath: string,
  filename: string,
): Promise<string | null> {
  if (!WRITABLE_PROJECT_FILES.has(filename)) {
    throw new Error(`Refusing to read "${filename}".`);
  }
  if (!projectPath.startsWith(server.projectRoot + "/")) {
    throw new Error("Refusing to read outside the configured project root.");
  }
  const res = await run(server, `cat ${sq(`${projectPath}/${filename}`)} 2>/dev/null || true`);
  return res.stdout.length > 0 ? res.stdout : null;
}

/**
 * Write a template's files into a project directory.
 *
 * The files come from `lib/templates.ts` — defined in code, never supplied by a
 * client — and each relative path is re-validated here anyway.
 */
export async function seedProjectFiles(
  server: Server,
  projectPath: string,
  files: { path: string; content: string; executable?: boolean }[],
): Promise<void> {
  if (!projectPath.startsWith(server.projectRoot + "/")) {
    throw new Error("Refusing to write outside the configured project root.");
  }
  if (files.length === 0) return;
  if (files.length > 40) throw new Error("A template may write at most 40 files.");

  const parts: string[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Template path not allowed: ${file.path}`);
    }
    const target = `${projectPath}/${file.path}`;
    const dir = target.slice(0, target.lastIndexOf("/"));
    const encoded = Buffer.from(file.content, "utf8").toString("base64");
    parts.push(`mkdir -p ${sq(dir)}`);
    parts.push(`printf '%s' ${sq(encoded)} | base64 -d > ${sq(target)}`);
    if (file.executable) parts.push(`chmod +x ${sq(target)}`);
  }
  parts.push("echo seeded");

  const res = await run(server, parts.join(" && "), 60_000);
  if (!res.stdout.includes("seeded")) {
    throw new Error(`Could not write the template files: ${res.stderr.trim().slice(-300)}`);
  }
}

/**
 * Run a template's install/start command in its own tmux session.
 *
 * The command is a constant from `lib/templates.ts`. The session name is
 * derived and validated like any other, so this cannot address a pane that is
 * not ours.
 */
export async function runProjectCommand(
  server: Server,
  tmuxName: string,
  projectPath: string,
  command: string,
  opts: { wait?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  assertTmux(tmuxName);
  if (!projectPath.startsWith(server.projectRoot + "/")) {
    throw new Error("Refusing to run outside the configured project root.");
  }

  if (opts.wait) {
    // Install steps are waited for, so the app does not start before its
    // dependencies exist.
    const res = await run(
      server,
      `cd ${sq(projectPath)} && ${command} 2>&1 | tail -20`,
      300_000,
    );
    return { ok: res.code === 0, output: res.stdout.trim() };
  }

  await run(server, `tmux kill-session -t ${sq(`=${tmuxName}`)} 2>/dev/null || true`);
  const res = await run(
    server,
    `tmux new-session -d -s ${sq(tmuxName)} -c ${sq(projectPath)} ` +
      sq(`${command}; echo; echo "[process exited]"; exec "$SHELL" -l`),
    30_000,
  );
  return { ok: res.code === 0, output: res.stderr.trim() };
}

// --------------------------------------------------- claude process discovery

export type LiveAgent = {
  pid: number;
  cwd: string;
  kind: string;
  sessionId: string;
  name?: string;
  status?: string;
  startedAt?: number;
};

export type SessionStateFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  tmux?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  /** Present exactly when Remote Control is active for that process. */
  bridgeSessionId?: string;
};

/**
 * One round trip that answers "what is Claude doing on this host right now".
 *
 * Both sources are machine-readable and maintained by Claude Code itself:
 *  - `claude agents --json` lists live processes (documented for scripting)
 *  - ~/.claude/sessions/<pid>.json carries the tmux pane and the Remote Control
 *    bridge id for each running process.
 */
export async function discoverClaudeProcesses(
  server: Server,
): Promise<{ agents: LiveAgent[]; states: SessionStateFile[] }> {
  const res = await run(
    server,
    [
      `echo "###AGENTS"`,
      `claude agents --json 2>/dev/null || echo "[]"`,
      `echo "###STATES"`,
      `for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] || continue; cat "$f"; printf '\\n\\036'; done`,
    ].join("; "),
    30_000,
  );
  const s = splitSections(res.stdout);

  let agents: LiveAgent[] = [];
  try {
    const parsed: unknown = JSON.parse((s.AGENTS ?? "[]").trim() || "[]");
    if (Array.isArray(parsed)) agents = parsed as LiveAgent[];
  } catch {
    agents = [];
  }

  const states: SessionStateFile[] = [];
  for (const chunk of (s.STATES ?? "").split(RS)) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as SessionStateFile;
      if (typeof parsed.pid === "number") states.push(parsed);
    } catch {
      // A half-written state file is normal; skip it.
    }
  }

  return { agents, states };
}

export async function checkClaudeProcess(server: Server, pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const res = await run(server, `kill -0 ${sq(String(pid))} 2>/dev/null && echo yes || echo no`);
  return res.stdout.trim() === "yes";
}

// --------------------------------------------------------------- usage stats

export type UsageSnapshot = {
  available: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  assistantTurns: number | null;
  userTurns: number | null;
  model: string | null;
  lastActivityAt: string | null;
  transcriptPath: string | null;
};

export const EMPTY_USAGE: UsageSnapshot = {
  available: false,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  totalTokens: null,
  assistantTurns: null,
  userTurns: null,
  model: null,
  lastActivityAt: null,
  transcriptPath: null,
};

/**
 * Token usage comes from Claude Code's own transcript
 * (~/.claude/projects/<dir>/<id>.jsonl), where every assistant message carries
 * the API `usage` object verbatim. Nothing here is estimated: if the transcript
 * is missing, the snapshot stays `available: false` and the UI says so.
 *
 * The sums are computed on the remote host so only a handful of numbers travel
 * back. Each transcript line holds exactly one top-level "usage" object; the
 * `[^}]*` cut stops at the first nested object, which is what keeps the
 * per-iteration copies of the same counters from being added twice.
 */
export async function getUsage(server: Server, claudeSessionId: string): Promise<UsageSnapshot> {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId)) return EMPTY_USAGE;

  const script = [
    `F="$(ls -1 "$HOME"/.claude/projects/*/${claudeSessionId}.jsonl 2>/dev/null | head -1)"`,
    `if [ -z "$F" ]; then echo "###NONE"; exit 0; fi`,
    `echo "###FILE"; echo "$F"`,
    `echo "###MTIME"; stat -c %Y "$F" 2>/dev/null || stat -f %m "$F" 2>/dev/null || echo ""`,
    `echo "###ASSISTANT"; grep -c '"type":"assistant"' "$F" 2>/dev/null || true`,
    `echo "###USER"; grep -c '"type":"user"' "$F" 2>/dev/null || true`,
    `echo "###MODEL"; grep -o '"model":"[a-zA-Z0-9._-]*"' "$F" 2>/dev/null | tail -1 | cut -d'"' -f4`,
    `U="$(grep -oh '"usage":{[^}]*' "$F" 2>/dev/null | tr ',' '\\n')"`,
    `echo "###IN"; printf '%s\\n' "$U" | grep -o '"input_tokens":[0-9]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}'`,
    `echo "###OUT"; printf '%s\\n' "$U" | grep -o '"output_tokens":[0-9]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}'`,
    `echo "###CREAD"; printf '%s\\n' "$U" | grep -o '"cache_read_input_tokens":[0-9]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}'`,
    `echo "###CCREATE"; printf '%s\\n' "$U" | grep -o '"cache_creation_input_tokens":[0-9]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}'`,
  ].join("\n");

  const res = await run(server, script, 30_000);
  const s = splitSections(res.stdout);
  if (s.NONE !== undefined || !s.FILE?.trim()) return EMPTY_USAGE;

  const num = (v: string | undefined): number | null => {
    const first = (v ?? "").split("\n").map((l) => l.trim()).find(Boolean);
    if (first === undefined) return null;
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  };

  const input = num(s.IN);
  const output = num(s.OUT);
  const cacheRead = num(s.CREAD);
  const cacheCreate = num(s.CCREATE);
  const mtime = num(s.MTIME);

  const total =
    input !== null && output !== null && cacheRead !== null && cacheCreate !== null
      ? input + output + cacheRead + cacheCreate
      : null;

  return {
    available: true,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    totalTokens: total,
    assistantTurns: num(s.ASSISTANT),
    userTurns: num(s.USER),
    model: s.MODEL?.trim() || null,
    lastActivityAt: mtime ? new Date(mtime * 1000).toISOString() : null,
    transcriptPath: s.FILE.trim(),
  };
}

// ------------------------------------------------------------------- helpers

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Split `###NAME\n...` delimited output into a record. */
function splitSections(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of out.split("\n")) {
    const match = /^###([A-Z]+)\s*$/.exec(line);
    if (match) {
      if (current) result[current] = buffer.join("\n");
      current = match[1];
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) result[current] = buffer.join("\n");
  return result;
}
