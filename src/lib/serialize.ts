import type { Resource, ResourceAllocation, Server, Session } from "@prisma/client";
import { asSessionState, type SessionState } from "./claude/state";
import { ClaudeAdapter } from "./claude/adapter";
import { parseUsage } from "./sessions";
import type { UsageSnapshot } from "./remote/ops";
import { toAllocationView, type AllocationView } from "./resources";
import { editorLinkFor, type EditorLink } from "./editor";

export type SessionDto = {
  id: string;
  projectName: string;
  projectPath: string;
  tmuxSession: string;
  state: SessionState;
  stateDetail: string | null;
  remoteUrl: string | null;
  bridgeSessionId: string | null;
  claudeSessionId: string | null;
  claudePid: number | null;
  model: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  createdAt: string;
  startedAt: string;
  stoppedAt: string | null;
  lastHealthyAt: string | null;
  lastActivityAt: string | null;
  uptimeMs: number | null;
  usage: UsageSnapshot | null;
  resources: AllocationView[];
  /** "Open in VS Code" for this project, if the server is configured for it. */
  editor: EditorLink;
  template: string;
  devPort: number | null;
  /** The template's app: NONE | STARTING | RUNNING | FAILED */
  appState: string;
  appDetail: string | null;
  /** Where the template's app is listening, when it is running. */
  appUrl: string | null;
  server: { id: string; name: string; host: string; status: string; active: boolean };
};

type SessionWithRelations = Session & {
  server: Server;
  allocations?: (ResourceAllocation & { resource: Resource })[];
};

export function toSessionDto(session: SessionWithRelations): SessionDto {
  const state = asSessionState(session.state);
  const started = session.createdAt;
  const endedAt = session.stoppedAt ?? null;
  const uptimeMs =
    state === "STOPPED" && endedAt
      ? endedAt.getTime() - started.getTime()
      : Date.now() - started.getTime();

  return {
    id: session.id,
    projectName: session.projectName,
    projectPath: session.projectPath,
    tmuxSession: session.tmuxSession,
    state,
    stateDetail: session.stateDetail,
    remoteUrl: ClaudeAdapter.getRemoteUrl(session),
    bridgeSessionId: session.bridgeSessionId,
    claudeSessionId: session.claudeSessionId,
    claudePid: session.claudePid,
    model: session.model,
    gitBranch: session.gitBranch,
    gitCommit: session.gitCommit,
    createdAt: session.createdAt.toISOString(),
    startedAt: started.toISOString(),
    stoppedAt: endedAt?.toISOString() ?? null,
    lastHealthyAt: session.lastHealthyAt?.toISOString() ?? null,
    lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
    uptimeMs: uptimeMs >= 0 ? uptimeMs : null,
    usage: parseUsage(session.usageJson),
    resources: (session.allocations ?? []).map((a) => toAllocationView(a)),
    template: session.template,
    devPort: session.devPort,
    appState: session.appState,
    appDetail: session.appDetail,
    appUrl:
      session.appState === "RUNNING" && session.devPort
        ? `http://${session.server.host}:${session.devPort}`
        : null,
    editor: editorLinkFor(session.server, {
      projectPath: session.projectPath,
      projectName: session.projectName,
    }),
    server: {
      id: session.server.id,
      name: session.server.name,
      host: session.server.host,
      status: session.server.status,
      active: session.server.active,
    },
  };
}
