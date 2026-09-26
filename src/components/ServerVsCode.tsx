"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner, VsCodeIcon } from "./SessionCard";

/**
 * Switching on VS Code in the browser for one host.
 *
 * Nothing to buy, but three things have to happen on the server: the CLI has to
 * be there, it has to be signed in to a GitHub or Microsoft account once, and a
 * tunnel has to run. So it is off until you turn it on — and every step shows
 * its own output, because a silent failure here is worse than no button.
 */

type Status = {
  cliPath: string | null;
  cliVersion: string | null;
  loggedIn: boolean;
  account: string | null;
  tunnelRunning: boolean;
  tunnelName: string | null;
  log: string | null;
};

type StepResult = {
  ok?: boolean;
  message?: string;
  log?: string;
  url?: string | null;
  code?: string | null;
  status?: Status;
  error?: string;
};

export function ServerVsCode({ serverId, onChange }: { serverId: string; onChange?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<StepResult | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/servers/${serverId}/vscode`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { status: Status };
    setStatus(data.status);
  }, [serverId]);

  useEffect(() => {
    if (open && !status) void load();
  }, [open, status, load]);

  async function step(name: "install" | "login" | "start" | "stop") {
    setBusy(name);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/vscode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: name }),
      });
      const data = (await res.json()) as StepResult;
      setResult(res.ok ? data : { ok: false, message: data.error ?? "That step failed." });
      if (data.status) setStatus(data.status);
      else await load();
      onChange?.();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const running = status?.tunnelRunning && status.tunnelName;

  return (
    <div className="mt-2 rounded-xl bg-[var(--bg-sunken)] p-3">
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-[var(--text-muted)]">
          <VsCodeIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">VS Code in the browser — optional</span>
          <span className="block truncate text-[11px] text-[var(--text-muted)]">
            {running
              ? `Tunnel "${status?.tunnelName}" is up`
              : "Off. Free, but needs a one-time sign-in on this host."}
          </span>
        </span>
        {running ? <span className="pill pill-ok shrink-0">Active</span> : null}
        <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{open ? "Hide" : "Set up"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] leading-snug text-[var(--text-muted)]">
            Uses Microsoft&rsquo;s own tunnel: the server only makes outbound connections, nothing is
            exposed, and projects open at vscode.dev from any device. Once it is running, every
            session card on this host gets an <em>Open in VS Code</em> button.
          </p>

          <ol className="space-y-2">
            <Step
              n={1}
              title="VS Code CLI on the host"
              done={Boolean(status?.cliPath)}
              detail={status?.cliVersion ?? status?.cliPath ?? "Not installed yet."}
              action="Install"
              busy={busy === "install"}
              disabled={busy !== null}
              onAction={() => void step("install")}
            />
            <Step
              n={2}
              title="Sign in once"
              done={Boolean(status?.loggedIn)}
              detail={status?.loggedIn ? (status.account ?? "Signed in.") : "Not signed in."}
              action={status?.loggedIn ? "Sign in again" : "Sign in"}
              busy={busy === "login"}
              disabled={busy !== null || !status?.cliPath}
              onAction={() => void step("login")}
            />
            <Step
              n={3}
              title="Run the tunnel"
              done={Boolean(running)}
              detail={running ? `vscode.dev/tunnel/${status?.tunnelName}` : "Not running."}
              action={running ? "Restart" : "Start tunnel"}
              busy={busy === "start"}
              disabled={busy !== null || !status?.loggedIn}
              onAction={() => void step("start")}
            />
          </ol>

          {result?.code ? (
            <div className="rounded-lg border border-[var(--warn-fg)] p-3">
              <p className="text-[12px] leading-snug text-[var(--warn-fg)]">
                Open the page, enter this code, then come back and start the tunnel.
              </p>
              <p className="mt-2 text-center font-mono text-[20px] tracking-widest">{result.code}</p>
              <div className="mt-2 flex gap-2">
                {result.url ? (
                  <a
                    className="btn btn-primary flex-1"
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open sign-in page
                  </a>
                ) : null}
                <button
                  className="btn btn-secondary flex-1"
                  onClick={() => void navigator.clipboard.writeText(result.code ?? "")}
                >
                  Copy code
                </button>
              </div>
            </div>
          ) : null}

          {result?.message ? (
            <p
              className={`text-[12px] leading-snug ${
                result.ok === false ? "text-[var(--bad-fg)]" : "text-[var(--text-muted)]"
              }`}
            >
              {result.message}
            </p>
          ) : null}

          {result?.log || status?.log ? (
            <details>
              <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">
                Output from the server
              </summary>
              <pre className="terminal mt-2 max-h-48 text-[10px]">
                {(result?.log || status?.log || "").trimEnd()}
              </pre>
            </details>
          ) : null}

          <div className="flex gap-2">
            <button
              className="btn btn-ghost flex-1 text-[12px]"
              onClick={() => void load()}
              disabled={busy !== null}
            >
              Refresh
            </button>
            {running ? (
              <button
                className="btn btn-ghost flex-1 text-[12px]"
                onClick={() => void step("stop")}
                disabled={busy !== null}
              >
                {busy === "stop" ? <Spinner /> : null}
                Stop tunnel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Step({
  n,
  title,
  done,
  detail,
  action,
  busy,
  disabled,
  onAction,
}: {
  n: number;
  title: string;
  done: boolean;
  detail: string;
  action: string;
  busy: boolean;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
          done ? "bg-[var(--ok-bg)] text-[var(--ok-fg)]" : "bg-[var(--idle-bg)] text-[var(--idle-fg)]"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{title}</span>
        <span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">{detail}</span>
      </span>
      <button
        className="btn btn-secondary shrink-0 px-3 text-[12px]"
        onClick={onAction}
        disabled={disabled}
      >
        {busy ? <Spinner /> : null}
        {action}
      </button>
    </li>
  );
}
