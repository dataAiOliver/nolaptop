"use client";

import Link from "next/link";
import { useState } from "react";
import type { SessionDto } from "@/lib/serialize";
import { STATE_UI, type SessionState } from "@/lib/claude/state";
import { formatDuration, formatRelative } from "@/lib/format";
import { useLive } from "./LiveProvider";

type Props = { session: SessionDto };

export type ActionName =
  | "stop"
  | "resume"
  | "reconnect"
  | "restart"
  | "authenticate"
  | "approve"
  | "refresh";

export async function callAction(
  sessionId: string,
  action: ActionName,
): Promise<{ ok: boolean; message: string; url?: string | null }> {
  const res = await fetch(`/api/sessions/${sessionId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = (await res.json()) as {
    result?: { ok: boolean; message: string; url?: string | null };
    error?: string;
  };
  if (!res.ok) return { ok: false, message: data.error ?? `Request failed (${res.status}).` };
  return data.result ?? { ok: true, message: "Done." };
}

/**
 * The primary action depends entirely on the state — the point of the card is
 * that the one thing you need to do next is the big button.
 */
function primaryAction(state: SessionState): { action: ActionName; label: string } | null {
  switch (state) {
    case "AUTH_REQUIRED":
      return { action: "authenticate", label: "Authenticate Claude" };
    case "APPROVAL_REQUIRED":
      return { action: "approve", label: "Approve" };
    case "REMOTE_DISCONNECTED":
      return { action: "reconnect", label: "Reconnect Remote Control" };
    case "STOPPED":
      return { action: "resume", label: "Resume session" };
    case "ERROR":
      return { action: "restart", label: "Restart session" };
    default:
      return null;
  }
}

export function SessionCard({ session }: Props) {
  const { refresh } = useLive();
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const ui = STATE_UI[session.state];
  const primary = primaryAction(session.state);
  const canOpen = Boolean(session.remoteUrl) && session.state === "REMOTE_CONNECTED";

  async function run(action: ActionName) {
    setBusy(action);
    setNote(null);
    const result = await callAction(session.id, action);
    setNote({ ok: result.ok, message: result.message });
    if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
    await refresh();
    setBusy(null);
  }

  async function copyUrl() {
    if (!session.remoteUrl) return;
    try {
      await navigator.clipboard.writeText(session.remoteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNote({ ok: false, message: "The browser would not give access to the clipboard." });
    }
  }

  return (
    <article className="card min-w-0 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link href={`/sessions/${session.id}`} className="block min-w-0">
              <h2 className="truncate text-[17px] font-semibold leading-tight">
                {session.projectName}
              </h2>
            </Link>
            <p className="mt-1 truncate text-[13px] text-[var(--text-muted)]">
              {session.server.name} · {formatDuration(session.uptimeMs)} up
            </p>
          </div>
          <span className={`pill ${ui.className} shrink-0`}>
            <span aria-hidden>{ui.dot}</span>
            {ui.label}
          </span>
        </div>

        {session.description ? (
          <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-[var(--text-muted)]">
            {session.description}
          </p>
        ) : null}

        {session.stateDetail ? (
          <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">
            {session.stateDetail}
          </p>
        ) : null}

        {/* Primary action, full width — the one-tap path on a phone. */}
        <div className="mt-3 flex flex-col gap-2">
          {canOpen ? (
            <a
              className="btn btn-primary btn-lg w-full"
              href={session.remoteUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Claude
            </a>
          ) : null}

          {primary ? (
            <button
              className={`btn btn-lg w-full ${canOpen ? "btn-secondary" : "btn-primary"}`}
              onClick={() => void run(primary.action)}
              disabled={busy !== null}
            >
              {busy === primary.action ? <Spinner /> : null}
              {primary.label}
            </button>
          ) : null}

          {!canOpen && !primary && session.state === "STARTING" ? (
            <div className="btn btn-secondary btn-lg w-full cursor-default">
              <Spinner />
              Starting…
            </div>
          ) : null}

          {session.appUrl ? (
            <a
              className="btn btn-secondary w-full"
              href={session.appUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open app · port {session.devPort}
            </a>
          ) : null}

          {session.appState === "STARTING" ? (
            <div className="btn btn-secondary w-full cursor-default text-[var(--text-muted)]">
              <Spinner />
              Starting the app…
            </div>
          ) : null}

          {session.appState === "FAILED" ? (
            <p className="text-[12px] leading-snug text-[var(--bad-fg)]">
              The starter app did not start. {session.appDetail}
            </p>
          ) : null}

          {session.editor ? (
            <a
              className="btn btn-secondary w-full"
              href={session.editor.url}
              target={session.editor.browser ? "_blank" : undefined}
              rel={session.editor.browser ? "noopener noreferrer" : undefined}
            >
              <VsCodeIcon />
              {session.editor.label}
            </a>
          ) : null}
        </div>

        {/* Secondary actions: a compact row, still 44px tall. */}
        <div className="mt-2 flex flex-wrap gap-2">
          {session.remoteUrl ? (
            <button className="btn btn-ghost flex-1" onClick={() => void copyUrl()}>
              {copied ? "Copied" : "Copy link"}
            </button>
          ) : null}
          {session.state !== "STOPPED" && session.state !== "SERVER_OFFLINE" ? (
            <button
              className="btn btn-ghost flex-1"
              onClick={() => void run("stop")}
              disabled={busy !== null}
            >
              {busy === "stop" ? <Spinner /> : null}
              Stop
            </button>
          ) : null}
          <Link className="btn btn-ghost flex-1" href={`/sessions/${session.id}`}>
            Details
          </Link>
        </div>

        {note ? (
          <p
            className={`mt-2 text-[13px] leading-snug ${
              note.ok ? "text-[var(--text-muted)]" : "text-[var(--bad-fg)]"
            }`}
          >
            {note.message}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2 text-[12px] text-[var(--text-faint)]">
        <span className="truncate">
          {session.gitBranch ? `${session.gitBranch} · ` : ""}
          {session.model ?? "model n/a"}
        </span>
        <span className="shrink-0">Checked {formatRelative(session.lastHealthyAt)}</span>
      </div>
    </article>
  );
}

/** The VS Code mark, simplified to a single path so it stays crisp at 16px. */
export function VsCodeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.6 2.2 9.9 9.5 5.5 6.2l-1.4.7v10.2l1.4.7 4.4-3.3 7.7 7.3L21 21V3l-3.4-.8ZM5.9 14.8v-5.6l2.6 2.8-2.6 2.8Zm11.4 2.6-5.6-5.4 5.6-5.4v10.8Z" />
    </svg>
  );
}

export function Spinner() {
  return (
    <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
