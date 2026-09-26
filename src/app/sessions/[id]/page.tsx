"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { SessionDto } from "@/lib/serialize";
import type { UsageSnapshot } from "@/lib/remote/ops";
import type { Interrupt } from "@/lib/claude/interrupts";
import { STATE_UI } from "@/lib/claude/state";
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTokens,
} from "@/lib/format";
import { callAction, Spinner, VsCodeIcon, type ActionName } from "@/components/SessionCard";
import { useLive } from "@/components/LiveProvider";
import { SessionResources } from "@/components/SessionResources";
import { SessionLinks } from "@/components/SessionLinks";

type DetailResponse = {
  session: SessionDto;
  usage: UsageSnapshot | null;
  interrupt: Interrupt | null;
  terminal: string | null;
  events: { id: string; kind: string; message: string; createdAt: string }[];
};

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { refresh, sessions } = useLive();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [copied, setCopied] = useState(false);

  const id = params?.id;

  const load = useCallback(
    async (live = true) => {
      if (!id) return;
      try {
        const res = await fetch(`/api/sessions/${id}?live=${live ? "1" : "0"}`, {
          cache: "no-store",
        });
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setNote({ ok: false, message: body.error ?? "This session could not be loaded." });
          return;
        }
        setData((await res.json()) as DetailResponse);
      } finally {
        setLoading(false);
      }
    },
    [id, router],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // The list in LiveProvider updates over SSE; mirror that into the detail view
  // without paying for another live probe on every tick.
  const fromList = sessions.find((s) => s.id === id);
  useEffect(() => {
    if (!fromList || !data) return;
    if (fromList.state !== data.session.state || fromList.remoteUrl !== data.session.remoteUrl) {
      void load(false);
    }
  }, [fromList, data, load]);

  async function run(action: ActionName) {
    if (!id) return;
    setBusy(action);
    setNote(null);
    const result = await callAction(id, action);
    setNote({ ok: result.ok, message: result.message });
    if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
    await Promise.all([load(true), refresh()]);
    setBusy(null);
  }

  async function remove(stop: boolean) {
    if (!id) return;
    const confirmed = window.confirm(
      stop
        ? "Stop the session and remove it from the dashboard? The conversation stays on the server."
        : "Remove this session from the dashboard? It keeps running on the server.",
    );
    if (!confirmed) return;
    await fetch(`/api/sessions/${id}?stop=${stop ? "1" : "0"}`, { method: "DELETE" });
    await refresh();
    router.push("/");
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-7 w-2/5" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card p-6 text-center">
        <p className="text-[14px] text-[var(--text-muted)]">
          {note?.message ?? "This session does not exist."}
        </p>
        <Link href="/" className="btn btn-secondary mt-4">
          Back to sessions
        </Link>
      </div>
    );
  }

  const session = data.session;
  const ui = STATE_UI[session.state];
  const usage = data.usage;
  const interrupt = data.interrupt && data.interrupt.kind !== "NONE" ? data.interrupt : null;

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
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/" className="btn btn-ghost -ml-3 px-3">
          ← Sessions
        </Link>
      </div>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">{session.projectName}</h1>
          <span className={`pill ${ui.className}`}>
            <span aria-hidden>{ui.dot}</span>
            {ui.label}
          </span>
        </div>
        <p className="mt-1 break-all text-[13px] text-[var(--text-muted)]">
          {session.server.name} · <code className="font-mono">{session.projectPath}</code>
        </p>
        {session.stateDetail ? (
          <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">
            {session.stateDetail}
          </p>
        ) : null}
      </header>

      {interrupt ? (
        <section className="card border-[var(--warn-fg)] p-4">
          <h2 className="text-[15px] font-semibold text-[var(--warn-fg)]">{interrupt.title}</h2>
          {interrupt.evidence ? (
            <pre className="terminal mt-2 max-h-32 text-[11px]">{interrupt.evidence}</pre>
          ) : null}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {interrupt.url ? (
              <a
                className="btn btn-primary btn-lg flex-1"
                href={interrupt.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in browser
              </a>
            ) : null}
            <button
              className={`btn btn-lg flex-1 ${interrupt.url ? "btn-secondary" : "btn-primary"}`}
              onClick={() => void run(interrupt.kind === "LOGIN" || interrupt.kind === "REAUTH" ? "authenticate" : "approve")}
              disabled={busy !== null}
            >
              {busy ? <Spinner /> : null}
              {interrupt.actionLabel}
            </button>
          </div>
        </section>
      ) : null}

      <section className="space-y-2">
        {session.remoteUrl ? (
          <>
            <a
              className="btn btn-primary btn-lg w-full"
              href={session.remoteUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Claude
            </a>
            <button className="btn btn-secondary w-full" onClick={() => void copyUrl()}>
              {copied ? "Link copied" : "Copy Remote Control link"}
            </button>
            <p className="break-all text-center font-mono text-[11px] text-[var(--text-faint)]">
              {session.remoteUrl}
            </p>
          </>
        ) : (
          <p className="card p-3 text-center text-[13px] text-[var(--text-muted)]">
            No Remote Control link yet.
          </p>
        )}

        {session.editor ? (
          <a
            className="btn btn-secondary btn-lg w-full"
            href={session.editor.url}
            target={session.editor.browser ? "_blank" : undefined}
            rel={session.editor.browser ? "noopener noreferrer" : undefined}
          >
            <VsCodeIcon />
            {session.editor.label}
          </a>
        ) : null}
      </section>

      <section className="grid grid-cols-2 gap-2">
        <ActionButton label="Reconnect" onClick={() => void run("reconnect")} busy={busy === "reconnect"} disabled={busy !== null} />
        <ActionButton label="Resume" onClick={() => void run("resume")} busy={busy === "resume"} disabled={busy !== null} />
        <ActionButton label="Restart" onClick={() => void run("restart")} busy={busy === "restart"} disabled={busy !== null} />
        <ActionButton label="Refresh status" onClick={() => void run("refresh")} busy={busy === "refresh"} disabled={busy !== null} />
        <ActionButton label="Authenticate" onClick={() => void run("authenticate")} busy={busy === "authenticate"} disabled={busy !== null} />
        <button
          className="btn btn-danger"
          onClick={() => void run("stop")}
          disabled={busy !== null || session.state === "STOPPED"}
        >
          {busy === "stop" ? <Spinner /> : null}
          Stop
        </button>
      </section>

      {note ? (
        <p
          className={`card p-3 text-[13px] leading-snug ${
            note.ok ? "text-[var(--text-muted)]" : "border-[var(--bad-fg)] text-[var(--bad-fg)]"
          }`}
        >
          {note.message}
        </p>
      ) : null}

      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Session
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
          <Fact label="Started" value={formatDateTime(session.startedAt)} />
          <Fact label="Uptime" value={formatDuration(session.uptimeMs)} />
          <Fact label="Last activity" value={formatRelative(session.lastActivityAt)} />
          <Fact label="Last health check" value={formatRelative(session.lastHealthyAt)} />
          <Fact label="Model" value={session.model ?? "Not available"} mono />
          <Fact label="Git branch" value={session.gitBranch ?? "Not available"} mono />
          <Fact label="tmux session" value={session.tmuxSession} mono />
          <Fact label="Claude PID" value={session.claudePid ? String(session.claudePid) : "Not available"} mono />
          <Fact label="Claude session" value={session.claudeSessionId ?? "Not available"} mono wide />
          <Fact label="Remote Control id" value={session.bridgeSessionId ?? "Not available"} mono wide />
          {session.gitCommit ? <Fact label="Last commit" value={session.gitCommit} mono wide /> : null}
        </dl>
      </section>

      <SessionLinks
        session={session}
        onChange={async () => {
          await Promise.all([load(false), refresh()]);
        }}
      />

      <SessionResources sessionId={session.id} />

      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Usage
        </h2>
        {usage?.available ? (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
              <Fact label="Total tokens" value={formatTokens(usage.totalTokens)} />
              <Fact label="Turns" value={formatNumber(usage.assistantTurns)} />
              <Fact label="Input" value={formatTokens(usage.inputTokens)} />
              <Fact label="Output" value={formatTokens(usage.outputTokens)} />
              <Fact label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
              <Fact label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
            </dl>
            <p className="mt-3 text-[12px] leading-snug text-[var(--text-faint)]">
              Read from Claude Code&rsquo;s own transcript for this session. Cost is not shown
              because the CLI does not expose a billed amount that can be read reliably.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[13px] text-[var(--text-muted)]">
            Not available — no transcript found for this session yet.
          </p>
        )}
      </section>

      <section className="card p-4">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowTerminal((v) => !v)}
        >
          <span className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
            Terminal
          </span>
          <span className="text-[13px] text-[var(--text-muted)]">{showTerminal ? "Hide" : "Show"}</span>
        </button>
        {showTerminal ? (
          <>
            <pre className="terminal mt-3">{data.terminal?.trimEnd() || "No output captured."}</pre>
            <button className="btn btn-ghost mt-2 w-full" onClick={() => void load(true)}>
              Refresh terminal
            </button>
          </>
        ) : null}
      </section>

      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Log
        </h2>
        <ul className="mt-3 space-y-2">
          {data.events.length === 0 ? (
            <li className="text-[13px] text-[var(--text-muted)]">Nothing logged yet.</li>
          ) : (
            data.events.map((event) => (
              <li key={event.id} className="flex gap-2 text-[12px] leading-snug">
                <span className="w-16 shrink-0 tabular-nums text-[var(--text-faint)]">
                  {formatClock(event.createdAt)}
                </span>
                <span
                  className={
                    event.kind === "error" ? "text-[var(--bad-fg)]" : "text-[var(--text-muted)]"
                  }
                >
                  {event.message}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Remove
        </h2>
        <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">
          Removing only deletes the dashboard entry. The project folder and the conversation stay
          on {session.server.name}.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button className="btn btn-secondary flex-1" onClick={() => void remove(false)}>
            Remove entry
          </button>
          <button className="btn btn-danger flex-1" onClick={() => void remove(true)}>
            Stop and remove
          </button>
        </div>
      </section>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  busy,
  disabled,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <button className="btn btn-secondary" onClick={onClick} disabled={disabled}>
      {busy ? <Spinner /> : null}
      {label}
    </button>
  );
}

function Fact({
  label,
  value,
  mono,
  wide,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "font-mono text-[12px]" : ""}`}>{value}</dd>
    </div>
  );
}
