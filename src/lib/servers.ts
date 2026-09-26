import type { Server } from "@prisma/client";
import { prisma } from "./db";
import { getHostInfo } from "./remote/ops";
import { dropConnection, SshError, type SshTarget } from "./ssh";
import { serversChanged } from "./events";
import type { ServerStatus } from "./claude/state";

/** A server as the client is allowed to see it: never the key material. */
export type PublicServer = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  projectRoot: string;
  description: string | null;
  active: boolean;
  status: ServerStatus;
  statusMessage: string | null;
  lastCheckAt: string | null;
  claudeVersion: string | null;
  tmuxVersion: string | null;
  hostKeyFingerprint: string | null;
  agentsFileName: string;
  agentsPreamble: string | null;
  editorMode: string;
  editorBaseUrl: string | null;
  editorTunnelName: string | null;
  editorSshHost: string | null;
  editorUrlTemplate: string | null;
  claudeAuth: {
    loggedIn: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
  } | null;
  sessionCount?: number;
};

export function toPublicServer(server: Server, sessionCount?: number): PublicServer {
  let claudeAuth: PublicServer["claudeAuth"] = null;
  if (server.claudeAuth) {
    try {
      claudeAuth = JSON.parse(server.claudeAuth);
    } catch {
      claudeAuth = null;
    }
  }
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    projectRoot: server.projectRoot,
    description: server.description,
    active: server.active,
    status: (server.status as ServerStatus) ?? "UNKNOWN",
    statusMessage: server.statusMessage,
    lastCheckAt: server.lastCheckAt?.toISOString() ?? null,
    claudeVersion: server.claudeVersion,
    tmuxVersion: server.tmuxVersion,
    hostKeyFingerprint: server.hostKeyFingerprint,
    agentsFileName: server.agentsFileName,
    agentsPreamble: server.agentsPreamble,
    editorMode: server.editorMode,
    editorBaseUrl: server.editorBaseUrl,
    editorTunnelName: server.editorTunnelName,
    editorSshHost: server.editorSshHost,
    editorUrlTemplate: server.editorUrlTemplate,
    claudeAuth,
    sessionCount,
  };
}

export type ProbeResult = {
  status: ServerStatus;
  message: string | null;
  claudeVersion: string | null;
  tmuxVersion: string | null;
  warnings: string[];
};

/**
 * Reachability probe. Beyond "can we connect", it records whether the two
 * things this app depends on are actually installed, because a server without
 * tmux or without the Claude CLI is online and still unusable.
 */
export async function probeServer(server: Server): Promise<ProbeResult> {
  const warnings: string[] = [];
  try {
    const info = await getHostInfo(server);
    if (!info.tmuxVersion) warnings.push("tmux was not found on this host.");
    if (!info.claudeVersion) warnings.push("The `claude` CLI was not found on this host.");
    if (info.auth && !info.auth.loggedIn) {
      warnings.push("Claude Code is not signed in on this host.");
    }

    const result: ProbeResult = {
      status: "ONLINE",
      message: warnings.length > 0 ? warnings.join(" ") : null,
      claudeVersion: info.claudeVersion,
      tmuxVersion: info.tmuxVersion,
      warnings,
    };

    await prisma.server.update({
      where: { id: server.id },
      data: {
        status: "ONLINE",
        statusMessage: result.message,
        lastCheckAt: new Date(),
        claudeVersion: info.claudeVersion,
        tmuxVersion: info.tmuxVersion,
        claudeAuth: info.auth ? JSON.stringify(info.auth) : null,
      },
    });
    serversChanged();
    return result;
  } catch (err) {
    const sshErr = err instanceof SshError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    const status: ServerStatus =
      sshErr?.kind === "AUTH" || sshErr?.kind === "EXEC" ? "CONNECTION_ERROR" : "OFFLINE";

    await prisma.server.update({
      where: { id: server.id },
      data: { status, statusMessage: message.slice(0, 500), lastCheckAt: new Date() },
    });
    dropConnection(server.id);
    serversChanged();
    return {
      status,
      message,
      claudeVersion: server.claudeVersion,
      tmuxVersion: server.tmuxVersion,
      warnings: [],
    };
  }
}

/** Probe a candidate server that has not been saved yet. */
export async function probeDraft(draft: SshTarget): Promise<ProbeResult> {
  try {
    const info = await getHostInfo(draft);
    const warnings: string[] = [];
    if (!info.tmuxVersion) warnings.push("tmux was not found on this host.");
    if (!info.claudeVersion) warnings.push("The `claude` CLI was not found on this host.");
    if (info.auth && !info.auth.loggedIn) warnings.push("Claude Code is not signed in on this host.");
    return {
      status: "ONLINE",
      message: warnings.length > 0 ? warnings.join(" ") : null,
      claudeVersion: info.claudeVersion,
      tmuxVersion: info.tmuxVersion,
      warnings,
    };
  } catch (err) {
    const sshErr = err instanceof SshError ? err : null;
    return {
      status: sshErr?.kind === "AUTH" ? "CONNECTION_ERROR" : "OFFLINE",
      message: err instanceof Error ? err.message : String(err),
      claudeVersion: null,
      tmuxVersion: null,
      warnings: [],
    };
  }
}
