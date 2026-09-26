import type { Server } from "@prisma/client";
import { sshExec } from "../ssh";
import { sq } from "../shell";

/**
 * VS Code in the browser, via Microsoft's own tunnel.
 *
 * Nothing here costs anything, but it is not free of setup either: the VS Code
 * CLI has to exist on the server, it has to be signed in to a GitHub or
 * Microsoft account once, and a tunnel process has to stay running. That is
 * exactly why it is off by default and switched on from the UI, the same way
 * the database and the object store are.
 *
 * The tunnel is the browser option worth having: the server only makes outbound
 * connections, nothing is exposed, and the result opens at vscode.dev from any
 * device — including the phone that started the project.
 */

const ENV_PREFIX = `export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"; `;

/** Where NoLaptop keeps the CLI it installs, so it never fights a system one. */
const BIN_DIR = "$HOME/.nolaptop/bin";
const CLI = "$HOME/.nolaptop/bin/code";

/** tmux sessions holding the two long-running steps. */
export const LOGIN_TMUX = "cc-vscode-login";
export const TUNNEL_TMUX = "cc-vscode-tunnel";

function run(server: Server, script: string, timeoutMs = 30_000) {
  return sshExec(server, ENV_PREFIX + script, { timeoutMs });
}

/**
 * Prefer a CLI that is already there — a system `code`, or the one VS Code's
 * own Remote-SSH extension installed — before downloading another copy.
 */
const RESOLVE_CLI =
  `CODE=""; ` +
  `if [ -x "${CLI}" ]; then CODE="${CLI}"; ` +
  `elif command -v code >/dev/null 2>&1; then CODE="$(command -v code)"; ` +
  `else CODE="$(ls -1t "$HOME"/.vscode-server/code-* 2>/dev/null | head -1)"; fi; `;

export type VsCodeStatus = {
  cliPath: string | null;
  cliVersion: string | null;
  loggedIn: boolean;
  account: string | null;
  tunnelRunning: boolean;
  tunnelName: string | null;
  /** The last lines of the tunnel's own output, for the UI. */
  log: string | null;
};

export async function inspectVsCode(server: Server): Promise<VsCodeStatus> {
  const res = await run(
    server,
    RESOLVE_CLI +
      [
        `echo "###CLI"; echo "$CODE"`,
        `echo "###VERSION"; [ -n "$CODE" ] && "$CODE" --version 2>/dev/null | head -1 || echo ""`,
        `echo "###USER"; [ -n "$CODE" ] && "$CODE" tunnel user show 2>/dev/null | head -1 || echo ""`,
        `echo "###STATUS"; [ -n "$CODE" ] && "$CODE" tunnel status 2>/dev/null | head -1 || echo ""`,
        `echo "###LOG"; tmux capture-pane -p -t ${sq(`=${TUNNEL_TMUX}:`)} -S -40 2>/dev/null || true`,
      ].join("; "),
    40_000,
  );

  const s = splitSections(res.stdout);
  const cliPath = s.CLI?.trim() || null;
  const account = s.USER?.trim() || "";
  const loggedIn = Boolean(account) && !/not logged in/i.test(account);

  let tunnelRunning = false;
  let tunnelName: string | null = null;
  try {
    const status = JSON.parse((s.STATUS ?? "").trim() || "{}") as {
      tunnel?: { name?: string; tunnel?: { name?: string } } | null;
    };
    const tunnel = status.tunnel;
    if (tunnel) {
      tunnelRunning = true;
      tunnelName = tunnel.name ?? tunnel.tunnel?.name ?? null;
    }
  } catch {
    tunnelRunning = false;
  }

  // The status call reports the *service*; a tunnel we run in tmux shows up in
  // its own output, so fall back to that.
  const log = s.LOG?.trim() || null;
  if (!tunnelName && log) {
    const match = /vscode\.dev\/tunnel\/([A-Za-z0-9._-]+)/.exec(log);
    if (match) {
      tunnelName = match[1];
      tunnelRunning = true;
    }
  }

  return {
    cliPath,
    cliVersion: s.VERSION?.trim() || null,
    loggedIn,
    account: loggedIn ? account : null,
    tunnelRunning,
    tunnelName,
    log,
  };
}

/** Download the official CLI if the host has none. */
export async function installVsCodeCli(server: Server): Promise<{ installed: boolean; log: string }> {
  const existing = await inspectVsCode(server);
  if (existing.cliPath) return { installed: false, log: `Using the CLI already at ${existing.cliPath}.` };

  // Only the alpine builds are published as a standalone CLI; they are static,
  // so they run on glibc hosts too.
  const script = [
    `mkdir -p ${BIN_DIR}`,
    `ARCH="$(uname -m)"`,
    `case "$ARCH" in x86_64|amd64) TARGET=cli-alpine-x64 ;; aarch64|arm64) TARGET=cli-alpine-arm64 ;; *) echo "unsupported architecture: $ARCH"; exit 1 ;; esac`,
    `cd ${BIN_DIR}`,
    `curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=$TARGET" -o code-cli.tar.gz`,
    `tar -xzf code-cli.tar.gz`,
    `rm -f code-cli.tar.gz`,
    `chmod +x ${CLI}`,
    `${CLI} --version | head -1`,
  ].join(" && ");

  const res = await run(server, script, 180_000);
  const log = (res.stdout + res.stderr).trim().slice(-600);
  if (res.code !== 0) throw new Error(`Could not install the VS Code CLI: ${log}`);
  return { installed: true, log };
}

export type LoginPrompt = { url: string | null; code: string | null; log: string };

/**
 * Start the device-code sign-in and hand back the code for the user to enter.
 *
 * NoLaptop never sees the account credentials: it starts the official flow and
 * shows you where to finish it, exactly as it does for Claude's own sign-in.
 */
export async function startVsCodeLogin(server: Server): Promise<LoginPrompt> {
  const { cliPath } = await inspectVsCode(server);
  if (!cliPath) throw new Error("No VS Code CLI on this host yet — install it first.");

  await run(server, `tmux kill-session -t ${sq(`=${LOGIN_TMUX}`)} 2>/dev/null || true`);
  // The path is resolved first and interpolated as a quoted literal, so there
  // is no nested-quoting puzzle and nothing the shell can re-interpret.
  const command = `${sq(cliPath)} tunnel user login --provider github; echo; echo "[login finished]"; sleep 600`;
  await run(
    server,
    `tmux new-session -d -s ${sq(LOGIN_TMUX)} -x 200 -y 50 ${sq(command)}`,
    30_000,
  );

  // The CLI prints the device code within a couple of seconds.
  await sleep(6000);
  const pane = await run(
    server,
    `tmux capture-pane -p -t ${sq(`=${LOGIN_TMUX}:`)} -S -40 2>/dev/null || true`,
  );
  const log = pane.stdout.trim();

  const urlMatch = /https?:\/\/[^\s'"]+/.exec(log.replace(/\n(?=[^\s])/g, ""));
  const codeMatch = /use code\s+([A-Z0-9-]+)/i.exec(log);

  return {
    url: urlMatch ? urlMatch[0].replace(/[.,]+$/, "") : null,
    code: codeMatch ? codeMatch[1] : null,
    log,
  };
}

/** Start the tunnel and wait until it reports its vscode.dev address. */
export async function startVsCodeTunnel(
  server: Server,
  name: string,
): Promise<{ tunnelName: string | null; log: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(name)) {
    throw new Error(`"${name}" is not a valid tunnel name (lowercase letters, digits and dashes).`);
  }

  const { cliPath, loggedIn } = await inspectVsCode(server);
  if (!cliPath) throw new Error("No VS Code CLI on this host yet — install it first.");
  if (!loggedIn) throw new Error("The VS Code CLI is not signed in on this host yet.");

  await run(server, `tmux kill-session -t ${sq(`=${TUNNEL_TMUX}`)} 2>/dev/null || true`);
  const command =
    `${sq(cliPath)} tunnel --accept-server-license-terms --name ${sq(name)}; ` +
    `echo; echo "[tunnel exited]"; exec "$SHELL" -l`;
  await run(
    server,
    `tmux new-session -d -s ${sq(TUNNEL_TMUX)} -x 200 -y 50 ${sq(command)}`,
    30_000,
  );

  for (let i = 0; i < 12; i += 1) {
    await sleep(5000);
    const pane = await run(
      server,
      `tmux capture-pane -p -t ${sq(`=${TUNNEL_TMUX}:`)} -S -60 2>/dev/null || true`,
    );
    const log = pane.stdout.trim();
    const match = /vscode\.dev\/tunnel\/([A-Za-z0-9._-]+)/.exec(log.replace(/\n(?=[^\s])/g, ""));
    if (match) return { tunnelName: match[1], log };
    if (/\[tunnel exited\]/.test(log)) {
      throw new Error(`The tunnel stopped straight away:\n${log.slice(-500)}`);
    }
  }

  const pane = await run(
    server,
    `tmux capture-pane -p -t ${sq(`=${TUNNEL_TMUX}:`)} -S -60 2>/dev/null || true`,
  );
  return { tunnelName: null, log: pane.stdout.trim() };
}

export async function stopVsCodeTunnel(server: Server): Promise<void> {
  const { cliPath } = await inspectVsCode(server);
  const kill = cliPath ? `${sq(cliPath)} tunnel kill 2>/dev/null; ` : "";
  await run(
    server,
    `${kill}tmux kill-session -t ${sq(`=${TUNNEL_TMUX}`)} 2>/dev/null || true`,
    60_000,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
