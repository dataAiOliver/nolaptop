/**
 * Recognising what a Claude Code process is waiting for.
 *
 * Claude Code exposes its *state* through machine-readable files (see
 * remote/ops.ts), but a blocking terminal dialog only exists on screen. So this
 * module reads the captured pane and classifies it — conservatively. A prompt we
 * do not recognise is reported as "unknown", never auto-answered.
 */

import type { TmuxKey } from "../remote/ops";

export type InterruptKind =
  | "WORKSPACE_TRUST"
  | "LOGIN"
  | "REMOTE_CONTROL_APPROVAL"
  | "TRUSTED_DEVICE"
  | "REAUTH"
  | "GENERIC_CONFIRM"
  | "NONE";

export type Interrupt = {
  kind: InterruptKind;
  /** Short, user-facing description of what is blocking. */
  title: string;
  /** Label for the primary button in the UI. */
  actionLabel: string;
  /** A URL the user must open in a browser, if the CLI printed one. */
  url: string | null;
  /**
   * Keys that answer this dialog, when it is safe to answer it on the user's
   * behalf. `null` means the app must not press anything by itself.
   */
  answerKeys: TmuxKey[] | null;
  /** The pane lines that triggered the match, for the session log. */
  evidence: string;
};

export const NO_INTERRUPT: Interrupt = {
  kind: "NONE",
  title: "",
  actionLabel: "",
  url: null,
  answerKeys: null,
  evidence: "",
};

/** URLs Claude prints for sign-in / device approval flows. */
const URL_RE = /https?:\/\/[^\s'"`<>()\]]+/g;

export function extractUrls(pane: string): string[] {
  // tmux wraps long lines; stitch a wrapped URL back together before matching.
  const unwrapped = pane.replace(/\n(?=[^\s])/g, "");
  const found = unwrapped.match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,]+$/, "")))];
}

export function extractRemoteControlUrl(pane: string): string | null {
  for (const url of extractUrls(pane)) {
    if (/claude\.ai\/code\/session_/.test(url)) return url;
  }
  return null;
}

function authUrl(pane: string): string | null {
  for (const url of extractUrls(pane)) {
    if (/(oauth|login|authorize|device|activate)/i.test(url)) return url;
    if (/claude\.ai|anthropic\.com|console\.anthropic/.test(url) && !/\/code\/session_/.test(url)) {
      return url;
    }
  }
  return null;
}

function evidenceFor(pane: string, matcher: RegExp): string {
  const lines = pane.split("\n").filter((l) => matcher.test(l));
  return lines.slice(-3).join("\n").trim().slice(0, 400);
}

/**
 * Classify the tail of a tmux pane.
 *
 * Order matters: the most specific, most actionable prompts are checked first.
 */
export function detectInterrupt(paneRaw: string): Interrupt {
  const pane = paneRaw.slice(-8000);
  const flat = pane.replace(/\s+/g, " ");

  // --- One-off workspace trust prompt -------------------------------------
  // Claude Code asks this the first time it opens a directory. The app created
  // that directory itself, inside the server's configured project root, so
  // confirming it is a decision the user already made by creating the project.
  if (
    /Is this a project you created or one you trust/i.test(flat) ||
    /Yes, I trust this folder/i.test(flat)
  ) {
    return {
      kind: "WORKSPACE_TRUST",
      title: "Claude Code is asking whether it may work in this folder.",
      actionLabel: "Trust folder",
      url: null,
      // "❯ No, exit" is preselected — move down one, then confirm.
      answerKeys: ["Down", "Enter"],
      evidence: evidenceFor(pane, /trust|project you created/i),
    };
  }

  // --- Not signed in ------------------------------------------------------
  if (
    /(Sign in to (your )?(Anthropic|Claude))/i.test(flat) ||
    /(Please (sign|log) in)/i.test(flat) ||
    /(Log in with your Claude|Claude account required)/i.test(flat) ||
    /(Invalid API key|Authentication (failed|required)|Not logged in)/i.test(flat) ||
    /\/login to (sign in|authenticate)/i.test(flat)
  ) {
    return {
      kind: "LOGIN",
      title: "Claude Code needs an Anthropic sign-in.",
      actionLabel: "Authenticate Claude",
      url: authUrl(pane),
      answerKeys: null,
      evidence: evidenceFor(pane, /sign in|log in|authenticat|api key/i),
    };
  }

  // --- Session expired / re-auth -----------------------------------------
  if (
    /(session (has )?expired|credentials (have )?expired|token (has )?expired)/i.test(flat) ||
    /(re-?authenticate|refresh your (login|credentials))/i.test(flat)
  ) {
    return {
      kind: "REAUTH",
      title: "The Claude sign-in on this server has expired.",
      actionLabel: "Re-authenticate",
      url: authUrl(pane),
      answerKeys: null,
      evidence: evidenceFor(pane, /expired|re-?authenticate/i),
    };
  }

  // --- Trusted device -----------------------------------------------------
  if (/(trusted device|verify this device|device approval|confirm this device)/i.test(flat)) {
    return {
      kind: "TRUSTED_DEVICE",
      title: "This device has to be confirmed in your Anthropic account.",
      actionLabel: "Confirm device",
      url: authUrl(pane),
      answerKeys: null,
      evidence: evidenceFor(pane, /device/i),
    };
  }

  // --- Remote Control approval -------------------------------------------
  if (
    /remote control/i.test(flat) &&
    /(approve|allow|enable|confirm|grant|permission)/i.test(flat) &&
    !/remote-control is active/i.test(flat)
  ) {
    return {
      kind: "REMOTE_CONTROL_APPROVAL",
      title: "Remote Control has not been approved yet.",
      actionLabel: "Approve Remote Control",
      url: authUrl(pane),
      // Approving remote access is not something to press blind.
      answerKeys: null,
      evidence: evidenceFor(pane, /remote control/i),
    };
  }

  // --- Some other selection prompt is on screen ---------------------------
  if (
    /(Enter to confirm|Press Enter to continue|\(y\/n\)|❯ Yes|❯ No)/i.test(flat) &&
    !/Try "/.test(flat)
  ) {
    return {
      kind: "GENERIC_CONFIRM",
      title: "Claude Code is waiting for an answer in the terminal.",
      actionLabel: "Show terminal",
      url: null,
      answerKeys: null,
      evidence: evidenceFor(pane, /confirm|continue|❯/i),
    };
  }

  return NO_INTERRUPT;
}

/** Does the pane show a healthy, ready Claude prompt? */
export function looksReady(pane: string): boolean {
  return /shift\+tab to cycle|for agents|\/effort|Try "|esc to interrupt/i.test(pane);
}
