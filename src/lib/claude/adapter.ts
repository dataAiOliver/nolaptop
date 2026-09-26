import type { Server, Session } from "@prisma/client";
import {
  captureClaudeOutput,
  checkClaudeProcess,
  createProject,
  createTmuxSession,
  discoverClaudeProcesses,
  EMPTY_USAGE,
  getGitInfo,
  getHostInfo,
  getUsage,
  killTmuxSession,
  sendClaudeInput,
  sendClaudeKeys,
  tmuxSessionExists,
  type ClaudeAuthStatus,
  type SessionStateFile,
  type UsageSnapshot,
} from "../remote/ops";
import { sq } from "../shell";
import { detectInterrupt, extractRemoteControlUrl, NO_INTERRUPT, type Interrupt } from "./interrupts";
import type { SessionState } from "./state";

/**
 * Everything Claude-Code-specific lives behind this adapter.
 *
 * The rest of the app talks about sessions, states and URLs; only this file
 * knows which CLI flags exist, where Claude keeps its state files and how a
 * Remote Control link is shaped. When the CLI changes, this is the file to fix.
 */

/** Remote Control links are `https://claude.ai/code/<bridgeSessionId>`. */
export const CLAUDE_WEB_BASE = "https://claude.ai/code";

export function remoteUrlFor(bridgeSessionId: string): string {
  return `${CLAUDE_WEB_BASE}/${bridgeSessionId}`;
}

/** How long a freshly started session may stay unobserved before we call it an error. */
const START_GRACE_MS = 90_000;

export type Observation = {
  state: SessionState;
  stateDetail: string | null;
  tmuxAlive: boolean;
  claudePid: number | null;
  claudeSessionId: string | null;
  bridgeSessionId: string | null;
  remoteUrl: string | null;
  /** Claude's own idea of what the process is doing: idle | busy | shell | … */
  processStatus: string | null;
  interrupt: Interrupt;
  paneTail: string | null;
  lastActivityAt: Date | null;
};

export class ClaudeAdapter {
  // ------------------------------------------------------------- lifecycle

  /**
   * Create the project directory on its own.
   *
   * Split out from startSession so backing services can be provisioned and
   * their `.env` written *before* Claude Code opens the folder — otherwise
   * Claude would start in a directory whose configuration is still missing.
   */
  static async prepareProject(
    server: Server,
    projectName: string,
  ): Promise<{ path: string; created: boolean }> {
    return createProject(server, projectName);
  }

  /**
   * Create the project directory and bring up a detached tmux session running
   * Claude Code with Remote Control enabled.
   */
  static async startSession(
    server: Server,
    opts: { projectName: string; tmuxSession: string; resumeSessionId?: string | null },
  ): Promise<{ projectPath: string; createdDir: boolean }> {
    const { path: projectPath, created } = await createProject(server, opts.projectName);

    const command = ClaudeAdapter.buildStartCommand({
      projectName: opts.projectName,
      resumeSessionId: opts.resumeSessionId ?? null,
    });

    await createTmuxSession(server, opts.tmuxSession, projectPath, command);
    return { projectPath, createdDir: created };
  }

  /**
   * `claude --remote-control <name>` starts an ordinary interactive session with
   * Remote Control already on — which is what makes the session both persistent
   * in tmux and reachable from claude.ai/code.
   *
   * The trailing `; exec $SHELL -l` keeps the tmux window alive after Claude
   * exits, so a crash leaves evidence on screen instead of a vanished session.
   */
  private static buildStartCommand(opts: {
    projectName: string;
    resumeSessionId: string | null;
  }): string {
    const parts = ["claude"];
    if (opts.resumeSessionId) {
      parts.push("--resume", sq(opts.resumeSessionId));
    }
    parts.push("--remote-control", sq(opts.projectName));
    parts.push("-n", sq(opts.projectName));
    return `${parts.join(" ")}; exec "$SHELL" -l`;
  }

  /**
   * Stop the session. The tmux session is killed; the conversation itself lives
   * in Claude's transcript and can be resumed later, so nothing is lost.
   */
  static async stopSession(server: Server, session: Session): Promise<void> {
    await killTmuxSession(server, session.tmuxSession);
  }

  /** Start a fresh tmux session that resumes the previous conversation. */
  static async resumeSession(server: Server, session: Session): Promise<void> {
    if (await tmuxSessionExists(server, session.tmuxSession)) {
      await killTmuxSession(server, session.tmuxSession);
    }
    const command = ClaudeAdapter.buildStartCommand({
      projectName: session.projectName,
      resumeSessionId: session.claudeSessionId,
    });
    await createTmuxSession(server, session.tmuxSession, session.projectPath, command);
  }

  /**
   * Re-enable Remote Control on a session that is still running.
   *
   * This types the `/remote-control` command into the live prompt — the same
   * thing the user would do in the terminal. The conversation is untouched.
   *
   * On a session that is *already* connected the command opens a menu
   * (disconnect / QR code / continue) instead of reconnecting. That menu would
   * sit there blocking input, so it is dismissed with Escape, leaving the
   * session exactly as it was found.
   */
  static async reconnectRemoteControl(server: Server, session: Session): Promise<void> {
    if (!(await tmuxSessionExists(server, session.tmuxSession))) {
      throw new Error("The tmux session is gone — use Resume Session instead.");
    }
    await sendClaudeInput(server, session.tmuxSession, "/remote-control");
    await sleep(3500);

    const pane = await captureClaudeOutput(server, session.tmuxSession, 40);
    if (isRemoteControlMenu(pane)) {
      await sendClaudeKeys(server, session.tmuxSession, ["Escape"]);
    }
  }

  // -------------------------------------------------------------- read side

  static getRemoteUrl(session: Session): string | null {
    if (session.remoteUrl) return session.remoteUrl;
    return session.bridgeSessionId ? remoteUrlFor(session.bridgeSessionId) : null;
  }

  static async getAuthenticationStatus(server: Server): Promise<ClaudeAuthStatus | null> {
    const info = await getHostInfo(server);
    return info.auth;
  }

  static async getUsage(server: Server, session: Session): Promise<UsageSnapshot> {
    if (!session.claudeSessionId) return EMPTY_USAGE;
    return getUsage(server, session.claudeSessionId);
  }

  static async captureTerminal(server: Server, session: Session, lines = 80): Promise<string> {
    return captureClaudeOutput(server, session.tmuxSession, lines);
  }

  /**
   * Validate a session against reality: tmux, the Claude process, Remote
   * Control, and — only when something looks off — the terminal itself.
   */
  static async getConnectionStatus(server: Server, session: Session): Promise<Observation> {
    const [tmuxAlive, discovered] = await Promise.all([
      tmuxSessionExists(server, session.tmuxSession),
      discoverClaudeProcesses(server),
    ]);

    const match = pickProcess(discovered.states, session);
    const agent = match
      ? discovered.agents.find((a) => a.pid === match.pid) ?? null
      : discovered.agents.find(
          (a) => a.cwd === session.projectPath && a.kind === "interactive",
        ) ?? null;

    const claudePid = match?.pid ?? agent?.pid ?? null;
    const claudeSessionId = match?.sessionId ?? agent?.sessionId ?? session.claudeSessionId ?? null;
    const bridgeSessionId = match?.bridgeSessionId ?? null;
    const processStatus = match?.status ?? agent?.status ?? null;
    const lastActivityAt = match?.statusUpdatedAt ? new Date(match.statusUpdatedAt) : null;

    // Nothing is running.
    if (!claudePid) {
      if (!tmuxAlive) {
        return observation({
          state: session.stoppedAt ? "STOPPED" : withinGrace(session) ? "STARTING" : "STOPPED",
          stateDetail: tmuxAlive ? null : "No tmux session on the host.",
          tmuxAlive,
          claudeSessionId,
        });
      }
      // tmux is there but Claude is not — read the pane to find out why.
      const pane = await captureClaudeOutput(server, session.tmuxSession, 80);
      const interrupt = detectInterrupt(pane);
      if (interrupt.kind !== "NONE") {
        return observation({
          state: interruptState(interrupt),
          stateDetail: interrupt.title,
          tmuxAlive,
          claudeSessionId,
          interrupt,
          paneTail: pane,
        });
      }
      return observation({
        state: withinGrace(session) ? "STARTING" : "STOPPED",
        stateDetail: "tmux is running but Claude Code has exited.",
        tmuxAlive,
        claudeSessionId,
        paneTail: pane,
      });
    }

    // Remote Control is live — the bridge id is written by Claude itself, so
    // this needs no screen scraping at all.
    if (bridgeSessionId) {
      return observation({
        state: "REMOTE_CONNECTED",
        stateDetail: null,
        tmuxAlive,
        claudePid,
        claudeSessionId,
        bridgeSessionId,
        remoteUrl: remoteUrlFor(bridgeSessionId),
        processStatus,
        lastActivityAt,
      });
    }

    // Running, but not bridged: look at the terminal to tell "blocked on a
    // dialog" apart from "Remote Control simply dropped".
    const pane = await captureClaudeOutput(server, session.tmuxSession, 80);
    const interrupt = detectInterrupt(pane);
    if (interrupt.kind !== "NONE" && interrupt.kind !== "GENERIC_CONFIRM") {
      return observation({
        state: interruptState(interrupt),
        stateDetail: interrupt.title,
        tmuxAlive,
        claudePid,
        claudeSessionId,
        processStatus,
        interrupt,
        paneTail: pane,
        lastActivityAt,
      });
    }

    // The URL can also be read off the pane if the state file has not caught up.
    const paneUrl = extractRemoteControlUrl(pane);
    if (paneUrl) {
      const id = paneUrl.split("/").pop() ?? null;
      return observation({
        state: "REMOTE_CONNECTED",
        stateDetail: null,
        tmuxAlive,
        claudePid,
        claudeSessionId,
        bridgeSessionId: id,
        remoteUrl: paneUrl,
        processStatus,
        paneTail: pane,
        lastActivityAt,
      });
    }

    const everBridged = Boolean(session.bridgeSessionId);
    return observation({
      state: everBridged ? "REMOTE_DISCONNECTED" : withinGrace(session) ? "STARTING" : "RUNNING",
      stateDetail: everBridged
        ? "Claude Code is running, but Remote Control is no longer active."
        : null,
      tmuxAlive,
      claudePid,
      claudeSessionId,
      processStatus,
      interrupt: interrupt.kind === "NONE" ? undefined : interrupt,
      paneTail: pane,
      lastActivityAt,
    });
  }

  // ----------------------------------------------------------- interventions

  /**
   * Answer a recognised, non-sensitive terminal dialog on the user's behalf.
   *
   * Only prompts that carry `answerKeys` may be answered this way — currently
   * just the workspace-trust question for a directory this app created itself.
   * Anything touching authentication or remote access is handed to the user.
   */
  static async answerInterrupt(
    server: Server,
    session: Session,
    interrupt: Interrupt,
  ): Promise<void> {
    if (!interrupt.answerKeys) {
      throw new Error(
        `"${interrupt.title}" has to be answered by you — the app will not confirm it automatically.`,
      );
    }
    await sendClaudeKeys(server, session.tmuxSession, interrupt.answerKeys);
  }

  /**
   * Start the official Anthropic sign-in inside the session and hand back the
   * URL the CLI prints. No credentials pass through this app.
   */
  static async requestLogin(server: Server, session: Session): Promise<{ url: string | null; pane: string }> {
    if (!(await tmuxSessionExists(server, session.tmuxSession))) {
      throw new Error("The tmux session is gone — start or resume the session first.");
    }
    await sendClaudeInput(server, session.tmuxSession, "/login");
    await sleep(4000);
    const pane = await captureClaudeOutput(server, session.tmuxSession, 120);
    const interrupt = detectInterrupt(pane);
    return { url: interrupt.url, pane };
  }

  /**
   * Bring the Remote Control approval in front of the user.
   *
   * If the CLI is showing an approval dialog with a URL, that URL is returned.
   * If approval can only be granted on claude.ai, the caller sends the user
   * there — this app never fakes an approval.
   */
  static async approveRemoteControl(
    server: Server,
    session: Session,
  ): Promise<{ url: string | null; handledInApp: boolean; pane: string }> {
    const pane = await captureClaudeOutput(server, session.tmuxSession, 120);
    const interrupt = detectInterrupt(pane);

    if (interrupt.kind === "WORKSPACE_TRUST" && interrupt.answerKeys) {
      await ClaudeAdapter.answerInterrupt(server, session, interrupt);
      return { url: null, handledInApp: true, pane };
    }
    if (interrupt.url) {
      return { url: interrupt.url, handledInApp: false, pane };
    }
    // Nothing on screen to approve: the approval lives in the Claude web app.
    const remote = ClaudeAdapter.getRemoteUrl(session);
    return { url: remote ?? CLAUDE_WEB_BASE, handledInApp: false, pane };
  }

  static async isProcessAlive(server: Server, pid: number): Promise<boolean> {
    return checkClaudeProcess(server, pid);
  }

  static async getGit(server: Server, session: Session) {
    return getGitInfo(server, session.projectPath);
  }
}

// --------------------------------------------------------------- internals

/**
 * The menu `/remote-control` shows when the session is already connected.
 * Recognised so it can be closed again rather than left blocking the prompt.
 */
function isRemoteControlMenu(pane: string): boolean {
  const flat = pane.replace(/\s+/g, " ");
  return /Disconnect this session/i.test(flat) || (/Show QR code/i.test(flat) && /Remote Control/i.test(flat));
}

function interruptState(interrupt: Interrupt): SessionState {
  switch (interrupt.kind) {
    case "LOGIN":
    case "REAUTH":
      return "AUTH_REQUIRED";
    case "WORKSPACE_TRUST":
    case "REMOTE_CONTROL_APPROVAL":
    case "TRUSTED_DEVICE":
    case "GENERIC_CONFIRM":
      return "APPROVAL_REQUIRED";
    default:
      return "RUNNING";
  }
}

/**
 * Find the Claude process that belongs to this managed session.
 *
 * The tmux name is the strong signal — it is ours and unique. The project path
 * is the fallback for a process that was started before the state file existed.
 */
function pickProcess(states: SessionStateFile[], session: Session): SessionStateFile | null {
  const byTmux = states.filter((s) => s.tmux?.split(":")[0] === session.tmuxSession);
  if (byTmux.length > 0) return newest(byTmux);

  const byPath = states.filter((s) => s.cwd === session.projectPath && s.kind !== "background");
  if (byPath.length > 0) return newest(byPath);

  return null;
}

function newest(states: SessionStateFile[]): SessionStateFile {
  return states.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a));
}

function withinGrace(session: Session): boolean {
  if (session.state !== "STARTING") return false;
  return Date.now() - new Date(session.updatedAt).getTime() < START_GRACE_MS;
}

function observation(partial: Partial<Observation> & { state: SessionState }): Observation {
  return {
    stateDetail: null,
    tmuxAlive: false,
    claudePid: null,
    claudeSessionId: null,
    bridgeSessionId: null,
    remoteUrl: null,
    processStatus: null,
    interrupt: NO_INTERRUPT,
    paneTail: null,
    lastActivityAt: null,
    ...partial,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
