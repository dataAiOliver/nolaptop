import type { Server, Session } from "@prisma/client";
import { prisma } from "./db";
import { ClaudeAdapter, type Observation } from "./claude/adapter";
import { asSessionState, type SessionState } from "./claude/state";
import { detectInterrupt, NO_INTERRUPT, type Interrupt } from "./claude/interrupts";
import { EMPTY_USAGE, type UsageSnapshot } from "./remote/ops";
import { appTmuxSessionName, isValidProjectName, projectPathWithin, tmuxSessionName } from "./shell";
import { templateById } from "./templates";
import { sessionChanged, sessionsChanged } from "./events";
import { SshError } from "./ssh";

/**
 * Session orchestration: everything that changes a managed session goes through
 * here, so state transitions, logging and change notification stay in one place.
 */

export class SessionError extends Error {}

export async function logEvent(
  sessionId: string,
  kind: "state-change" | "action" | "error" | "info",
  message: string,
): Promise<void> {
  await prisma.sessionEvent.create({
    data: { sessionId, kind, message: message.slice(0, 2000) },
  });
  // Keep the log bounded; a session that reconnects all day should not grow forever.
  const stale = await prisma.sessionEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    skip: 200,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.sessionEvent.deleteMany({ where: { id: { in: stale.map((e) => e.id) } } });
  }
}

// ------------------------------------------------------------------- create

export async function createSession(input: {
  serverId: string;
  projectName: string;
  resourceIds?: string[];
  template?: string;
}): Promise<Session> {
  const server = await prisma.server.findUnique({ where: { id: input.serverId } });
  if (!server) throw new SessionError("Unknown server.");
  if (!server.active) throw new SessionError(`Server "${server.name}" is set to inactive.`);
  if (!isValidProjectName(input.projectName)) {
    throw new SessionError(
      "Project names may contain lowercase letters, digits, dot, dash and underscore, and must start with a letter or digit.",
    );
  }

  const projectPath = projectPathWithin(server.projectRoot, input.projectName);

  const existing = await prisma.session.findUnique({
    where: { serverId_projectName: { serverId: server.id, projectName: input.projectName } },
  });
  if (existing) {
    throw new SessionError(
      `"${input.projectName}" already exists on ${server.name}. Open or resume that session instead.`,
    );
  }

  const session = await prisma.session.create({
    data: {
      serverId: server.id,
      projectName: input.projectName,
      projectPath,
      // Placeholder: the real name needs the generated id, set right below.
      tmuxSession: "cc-pending",
      state: "STARTING",
      template: templateById(input.template).id,
    },
  });

  const tmux = tmuxSessionName(input.projectName, session.id);
  const withTmux = await prisma.session.update({
    where: { id: session.id },
    data: { tmuxSession: tmux },
  });

  await logEvent(session.id, "action", `Session created for ${projectPath} on ${server.name}.`);
  sessionsChanged();

  // Bring it up in the background: the caller gets its session immediately and
  // watches the state travel from STARTING to REMOTE_CONNECTED over SSE.
  void bootSession(server, withTmux, input.resourceIds ?? []);

  return withTmux;
}

async function bootSession(
  server: Server,
  session: Session,
  resourceIds: string[],
): Promise<void> {
  try {
    // The folder first, so the environment can be in place before Claude Code
    // ever looks at the directory.
    await ClaudeAdapter.prepareProject(server, session.projectName);

    // Reserve a dev-server port so two projects on this host never collide.
    const { allocateDevPort } = await import("./devport");
    await allocateDevPort(server, session.id);
    const withPort = (await prisma.session.findUnique({ where: { id: session.id } })) ?? session;

    if (resourceIds.length > 0) {
      const { attachResources } = await import("./resources");
      await attachResources(server, withPort, resourceIds);
    } else {
      // Even with no services attached, the agent should know where it is.
      const { syncProjectFiles } = await import("./resources");
      await syncProjectFiles(server, withPort);
    }

    // Seed the starter template, then bring its app up in its own tmux session
    // so the project is already running when you open it.
    await seedAndStartTemplate(server, withPort);

    await ClaudeAdapter.startSession(server, {
      projectName: session.projectName,
      tmuxSession: session.tmuxSession,
    });
    await logEvent(session.id, "info", `tmux session ${session.tmuxSession} started.`);
    await prisma.session.update({
      where: { id: session.id },
      data: { state: "STARTING", stateDetail: "Waiting for Claude Code to come up." },
    });
    sessionChanged(session.id);

    // Give Claude a moment, then settle any first-run prompt and pick up the URL.
    for (const delay of [6000, 6000, 8000, 10000, 15000]) {
      await sleep(delay);
      const fresh = await prisma.session.findUnique({ where: { id: session.id } });
      if (!fresh) return;
      const obs = await refreshSession(server, fresh, { autoAnswerTrust: true });
      if (obs.state === "REMOTE_CONNECTED" || obs.state === "AUTH_REQUIRED") return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.session.update({
      where: { id: session.id },
      data: { state: "ERROR", stateDetail: message.slice(0, 500) },
    });
    await logEvent(session.id, "error", `Start failed: ${message}`);
    sessionChanged(session.id);
  }
}

// ------------------------------------------------------------------ refresh

/**
 * Check one session against the real world and persist what changed.
 *
 * `autoAnswerTrust` is only set while a session is starting up: the workspace
 * trust prompt for a directory this app just created is the one dialog it may
 * confirm on its own.
 */
export async function refreshSession(
  server: Server,
  session: Session,
  opts: { autoAnswerTrust?: boolean } = {},
): Promise<Observation & { usage: UsageSnapshot | null }> {
  let obs: Observation;
  try {
    obs = await ClaudeAdapter.getConnectionStatus(server, session);
  } catch (err) {
    const offline = err instanceof SshError;
    const message = err instanceof Error ? err.message : String(err);
    await applyState(session, {
      state: offline ? "SERVER_OFFLINE" : "ERROR",
      stateDetail: message.slice(0, 500),
    });
    return {
      state: offline ? "SERVER_OFFLINE" : "ERROR",
      stateDetail: message,
      tmuxAlive: false,
      claudePid: null,
      claudeSessionId: session.claudeSessionId,
      bridgeSessionId: session.bridgeSessionId,
      remoteUrl: session.remoteUrl,
      processStatus: null,
      interrupt: NO_INTERRUPT,
      paneTail: null,
      lastActivityAt: null,
      usage: null,
    };
  }

  if (
    opts.autoAnswerTrust &&
    obs.interrupt.kind === "WORKSPACE_TRUST" &&
    obs.interrupt.answerKeys
  ) {
    await ClaudeAdapter.answerInterrupt(server, session, obs.interrupt);
    await logEvent(
      session.id,
      "action",
      "Confirmed the workspace-trust prompt for the project directory this app created.",
    );
    await sleep(5000);
    obs = await ClaudeAdapter.getConnectionStatus(server, session);
  }

  const data: Record<string, unknown> = {
    state: obs.state,
    stateDetail: obs.stateDetail,
  };
  if (obs.claudePid !== null) data.claudePid = obs.claudePid;
  if (obs.claudeSessionId) data.claudeSessionId = obs.claudeSessionId;
  if (obs.bridgeSessionId) {
    data.bridgeSessionId = obs.bridgeSessionId;
    data.remoteUrl = obs.remoteUrl;
  }
  if (obs.lastActivityAt) data.lastActivityAt = obs.lastActivityAt;
  if (obs.state === "REMOTE_CONNECTED" || obs.state === "RUNNING") {
    data.lastHealthyAt = new Date();
    data.stoppedAt = null;
  }
  if (obs.state === "STOPPED" && !session.stoppedAt) {
    data.stoppedAt = new Date();
  }

  const changed = session.state !== obs.state;
  await prisma.session.update({ where: { id: session.id }, data });

  if (changed) {
    await logEvent(
      session.id,
      "state-change",
      `${session.state} → ${obs.state}${obs.stateDetail ? ` (${obs.stateDetail})` : ""}`,
    );
    sessionChanged(session.id);
  }

  return { ...obs, usage: null };
}

/** Refresh + collect the extras that are too expensive for the polling loop. */
export async function refreshSessionDetail(
  server: Server,
  session: Session,
): Promise<{ observation: Observation; usage: UsageSnapshot; pane: string | null }> {
  const observation = await refreshSession(server, session);
  const fresh = (await prisma.session.findUnique({ where: { id: session.id } })) ?? session;

  let usage: UsageSnapshot = EMPTY_USAGE;
  let pane: string | null = observation.paneTail;
  try {
    usage = await ClaudeAdapter.getUsage(server, fresh);
    if (usage.available) {
      await prisma.session.update({
        where: { id: fresh.id },
        data: {
          usageJson: JSON.stringify(usage),
          model: usage.model ?? fresh.model,
          lastActivityAt: usage.lastActivityAt ? new Date(usage.lastActivityAt) : fresh.lastActivityAt,
        },
      });
    }
    if (!pane) pane = await ClaudeAdapter.captureTerminal(server, fresh, 120);
    const git = await ClaudeAdapter.getGit(server, fresh);
    if (git.branch !== fresh.gitBranch || git.commit !== fresh.gitCommit) {
      await prisma.session.update({
        where: { id: fresh.id },
        data: { gitBranch: git.branch, gitCommit: git.commit },
      });
    }
  } catch {
    // Details are best-effort: a failure here must not change the session state.
  }

  return { observation, usage, pane };
}

async function applyState(
  session: Session,
  patch: { state: SessionState; stateDetail: string | null },
): Promise<void> {
  if (session.state === patch.state && session.stateDetail === patch.stateDetail) return;
  await prisma.session.update({ where: { id: session.id }, data: patch });
  if (session.state !== patch.state) {
    await logEvent(session.id, "state-change", `${session.state} → ${patch.state}`);
  }
  sessionChanged(session.id);
}

// ------------------------------------------------------------------ actions

export type SessionAction =
  | "stop"
  | "resume"
  | "reconnect"
  | "restart"
  | "authenticate"
  | "approve"
  | "refresh";

export type ActionResult = {
  ok: boolean;
  message: string;
  /** A URL the user should open, e.g. a sign-in page. */
  url?: string | null;
  state?: SessionState;
};

export async function runAction(
  sessionId: string,
  action: SessionAction,
): Promise<ActionResult> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { server: true },
  });
  if (!session) throw new SessionError("Unknown session.");
  const server = session.server;

  switch (action) {
    case "refresh": {
      const obs = await refreshSession(server, session);
      return { ok: true, message: "Status refreshed.", state: obs.state };
    }

    case "stop": {
      await ClaudeAdapter.stopSession(server, session);
      await prisma.session.update({
        where: { id: session.id },
        data: {
          state: "STOPPED",
          stateDetail: "Stopped from the dashboard. The conversation is kept.",
          stoppedAt: new Date(),
          bridgeSessionId: null,
          remoteUrl: null,
          claudePid: null,
        },
      });
      await logEvent(session.id, "action", "Session stopped. The conversation can be resumed.");
      sessionChanged(session.id);
      return { ok: true, message: "Session stopped. The conversation is kept.", state: "STOPPED" };
    }

    case "resume": {
      await ClaudeAdapter.resumeSession(server, session);
      await prisma.session.update({
        where: { id: session.id },
        data: { state: "STARTING", stateDetail: "Resuming the previous conversation.", stoppedAt: null },
      });
      await logEvent(
        session.id,
        "action",
        session.claudeSessionId
          ? `Resuming conversation ${session.claudeSessionId}.`
          : "Starting a new Remote Control session in the existing project.",
      );
      sessionChanged(session.id);
      void settleAfterAction(server.id, session.id);
      return { ok: true, message: "Session is starting.", state: "STARTING" };
    }

    case "reconnect": {
      // Already connected: re-check instead of poking a working session.
      if (session.state === "REMOTE_CONNECTED" && session.bridgeSessionId) {
        const obs = await refreshSession(server, session);
        if (obs.state === "REMOTE_CONNECTED") {
          return { ok: true, message: "Remote Control is already connected.", state: obs.state };
        }
      }
      await ClaudeAdapter.reconnectRemoteControl(server, session);
      await logEvent(session.id, "action", "Sent /remote-control to the running session.");
      await sleep(4000);
      const obs = await refreshSession(server, session);
      return {
        ok: obs.state === "REMOTE_CONNECTED",
        message:
          obs.state === "REMOTE_CONNECTED"
            ? "Remote Control is connected again."
            : "Reconnect sent — the session has not reported a Remote Control link yet.",
        state: obs.state,
      };
    }

    case "restart": {
      // Restart is resume with a clean tmux session: the conversation survives
      // because Claude is relaunched with --resume.
      await ClaudeAdapter.resumeSession(server, session);
      await prisma.session.update({
        where: { id: session.id },
        data: { state: "STARTING", stateDetail: "Restarting.", stoppedAt: null },
      });
      await logEvent(session.id, "action", "Session restarted.");
      sessionChanged(session.id);
      void settleAfterAction(server.id, session.id);
      return { ok: true, message: "Session is restarting.", state: "STARTING" };
    }

    case "authenticate": {
      const { url, pane } = await ClaudeAdapter.requestLogin(server, session);
      await logEvent(
        session.id,
        "action",
        url ? `Sign-in started, URL handed to the browser: ${url}` : "Sign-in started in the session.",
      );
      const obs = await refreshSession(server, session);
      return {
        ok: true,
        url: url ?? "https://claude.ai/login",
        message: url
          ? "Open the sign-in page, then come back — the status updates by itself."
          : "Claude Code did not print a sign-in link. Open the terminal view to see what it is asking for." +
            (pane ? "" : ""),
        state: obs.state,
      };
    }

    case "approve": {
      const result = await ClaudeAdapter.approveRemoteControl(server, session);
      if (result.handledInApp) {
        await logEvent(session.id, "action", "Confirmed the workspace-trust prompt.");
        await sleep(4000);
        const obs = await refreshSession(server, session);
        return { ok: true, message: "Confirmed.", state: obs.state };
      }
      await logEvent(
        session.id,
        "action",
        `Approval has to be granted by you${result.url ? `: ${result.url}` : ""}.`,
      );
      return {
        ok: true,
        url: result.url,
        message: "This approval can only be granted by you — opening the page now.",
      };
    }

    default:
      throw new SessionError(`Unknown action: ${action as string}`);
  }
}

/**
 * Write the template's files and start its app.
 *
 * Failures here are logged and do not fail the session: a project whose demo
 * app will not start is still a perfectly good project to work in.
 */
async function seedAndStartTemplate(server: Server, session: Session): Promise<void> {
  const template = templateById(session.template);
  if (template.files({ projectName: session.projectName, devPort: session.devPort }).length === 0) {
    return;
  }

  try {
    const { seedProjectFiles, runProjectCommand } = await import("./remote/ops");
    const files = template.files({
      projectName: session.projectName,
      devPort: session.devPort,
    });
    await seedProjectFiles(server, session.projectPath, files);
    await logEvent(session.id, "info", `Seeded the "${template.label}" template.`);

    if (!template.start) return;

    const appTmux = appTmuxSessionName(session.projectName, session.id);
    await prisma.session.update({
      where: { id: session.id },
      data: { appTmux, appState: "STARTING", appDetail: null },
    });
    sessionChanged(session.id);

    if (template.install) {
      const installed = await runProjectCommand(
        server,
        appTmux,
        session.projectPath,
        template.install,
        { wait: true },
      );
      if (!installed.ok) {
        await prisma.session.update({
          where: { id: session.id },
          data: { appState: "FAILED", appDetail: installed.output.slice(-400) },
        });
        await logEvent(session.id, "error", `Template install failed: ${installed.output.slice(-400)}`);
        sessionChanged(session.id);
        return;
      }
    }

    await runProjectCommand(server, appTmux, session.projectPath, template.start);
    await prisma.session.update({
      where: { id: session.id },
      data: {
        appState: "RUNNING",
        appDetail: session.devPort ? `Listening on port ${session.devPort}.` : null,
      },
    });
    await logEvent(
      session.id,
      "action",
      session.devPort
        ? `Started the template app on port ${session.devPort}.`
        : "Started the template app.",
    );
    sessionChanged(session.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.session.update({
      where: { id: session.id },
      data: { appState: "FAILED", appDetail: message.slice(0, 400) },
    });
    await logEvent(session.id, "error", `Template setup failed: ${message}`);
    sessionChanged(session.id);
  }
}

async function settleAfterAction(serverId: string, sessionId: string): Promise<void> {
  for (const delay of [6000, 8000, 10000, 15000]) {
    await sleep(delay);
    const [server, session] = await Promise.all([
      prisma.server.findUnique({ where: { id: serverId } }),
      prisma.session.findUnique({ where: { id: sessionId } }),
    ]);
    if (!server || !session) return;
    const obs = await refreshSession(server, session, { autoAnswerTrust: true });
    if (obs.state === "REMOTE_CONNECTED" || obs.state === "AUTH_REQUIRED") return;
  }
}

// ------------------------------------------------------------------- delete

export async function deleteSession(sessionId: string, opts: { stopFirst: boolean }): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { server: true },
  });
  if (!session) return;
  if (opts.stopFirst) {
    try {
      await ClaudeAdapter.stopSession(session.server, session);
    } catch {
      // Removing the entry must work even when the host is unreachable.
    }
  }
  await prisma.session.delete({ where: { id: sessionId } });
  sessionsChanged();
}

// ------------------------------------------------------------------ helpers

export function parseUsage(json: string | null): UsageSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as UsageSnapshot;
  } catch {
    return null;
  }
}

export function interruptFromPane(pane: string | null): Interrupt {
  return pane ? detectInterrupt(pane) : NO_INTERRUPT;
}

export function stateOf(session: Session): SessionState {
  return asSessionState(session.state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
