/** Lifecycle of a managed Claude Code session. */
export const SESSION_STATES = [
  "STARTING",
  "RUNNING",
  "REMOTE_CONNECTED",
  "REMOTE_DISCONNECTED",
  "AUTH_REQUIRED",
  "APPROVAL_REQUIRED",
  "STOPPED",
  "ERROR",
  "SERVER_OFFLINE",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

type Presentation = {
  label: string;
  dot: string;
  /** Tailwind classes for the status pill. */
  className: string;
  hint: string;
};

export const STATE_UI: Record<SessionState, Presentation> = {
  STARTING: {
    label: "Starting",
    dot: "🔵",
    className: "pill-info",
    hint: "tmux and Claude Code are coming up.",
  },
  RUNNING: {
    label: "Running",
    dot: "🟢",
    className: "pill-ok",
    hint: "Claude Code is running, Remote Control is not active yet.",
  },
  REMOTE_CONNECTED: {
    label: "Remote connected",
    dot: "🟢",
    className: "pill-ok",
    hint: "Reachable from claude.ai/code and the Claude app.",
  },
  REMOTE_DISCONNECTED: {
    label: "Remote disconnected",
    dot: "🟠",
    className: "pill-warn",
    hint: "The session is alive but Remote Control dropped. Reconnect keeps the conversation.",
  },
  AUTH_REQUIRED: {
    label: "Login required",
    dot: "🟡",
    className: "pill-warn",
    hint: "Claude Code is waiting for an Anthropic sign-in.",
  },
  APPROVAL_REQUIRED: {
    label: "Approval required",
    dot: "🟡",
    className: "pill-warn",
    hint: "A one-off prompt is blocking the session.",
  },
  STOPPED: {
    label: "Stopped",
    dot: "🔴",
    className: "pill-bad",
    hint: "No process is running. The conversation is kept and can be resumed.",
  },
  ERROR: {
    label: "Error",
    dot: "🔴",
    className: "pill-bad",
    hint: "The last check failed. See the session log.",
  },
  SERVER_OFFLINE: {
    label: "Server offline",
    dot: "⚫",
    className: "pill-idle",
    hint: "The host could not be reached over SSH.",
  },
};

export function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

export function asSessionState(value: string): SessionState {
  return isSessionState(value) ? value : "ERROR";
}

/** A state a user can act on right now, sorted to the top of the dashboard. */
export function needsAttention(state: SessionState): boolean {
  return (
    state === "AUTH_REQUIRED" ||
    state === "APPROVAL_REQUIRED" ||
    state === "REMOTE_DISCONNECTED" ||
    state === "ERROR"
  );
}

export function isLive(state: SessionState): boolean {
  return (
    state === "STARTING" ||
    state === "RUNNING" ||
    state === "REMOTE_CONNECTED" ||
    state === "REMOTE_DISCONNECTED" ||
    state === "AUTH_REQUIRED" ||
    state === "APPROVAL_REQUIRED"
  );
}

export const SERVER_STATUSES = ["ONLINE", "OFFLINE", "CONNECTION_ERROR", "UNKNOWN"] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const SERVER_STATUS_UI: Record<ServerStatus, { label: string; dot: string; className: string }> = {
  ONLINE: { label: "Online", dot: "🟢", className: "pill-ok" },
  OFFLINE: { label: "Offline", dot: "⚫", className: "pill-idle" },
  CONNECTION_ERROR: { label: "Connection error", dot: "🔴", className: "pill-bad" },
  UNKNOWN: { label: "Unknown", dot: "⚪", className: "pill-idle" },
};
