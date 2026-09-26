"use client";

import { useState } from "react";
import type { SessionDto } from "@/lib/serialize";
import { Spinner } from "./SessionCard";

/**
 * A project's own note, the ports and links worth remembering, and the one
 * command that makes those ports reachable from the laptop you are sitting at.
 */
export function SessionLinks({
  session,
  onChange,
}: {
  session: SessionDto;
  onChange: () => Promise<void> | void;
}) {
  const [description, setDescription] = useState(session.description ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);

  const [label, setLabel] = useState("");
  const [port, setPort] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shell, setShell] = useState<"bash" | "powershell">("bash");
  const [background, setBackground] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function saveDescription() {
    setSavingNote(true);
    setNoteSaved(false);
    await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    await onChange();
    setSavingNote(false);
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2000);
  }

  async function addLink(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    setError(null);
    const res = await fetch(`/api/sessions/${session.id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: label.trim(),
        port: port.trim() ? Number(port) : null,
        url: url.trim() || null,
      }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) setError(body.error ?? "Could not save that.");
    else {
      setLabel("");
      setPort("");
      setUrl("");
      await onChange();
    }
    setAdding(false);
  }

  async function removeLink(linkId: string) {
    await fetch(`/api/sessions/${session.id}/links?linkId=${linkId}`, { method: "DELETE" });
    await onChange();
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("The browser would not give access to the clipboard.");
    }
  }

  const forward = session.forward;
  const command = background
    ? shell === "bash"
      ? forward.commands.bashBackground
      : forward.commands.powershellBackground
    : shell === "bash"
      ? forward.commands.bash
      : forward.commands.powershell;

  return (
    <>
      {/* ---------------------------------------------------- description */}
      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          What this is
        </h2>
        <textarea
          className="field mt-3 min-h-20 text-[14px]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A sentence for future you. What is this project, and why did you start it?"
        />
        <button
          className="btn btn-secondary mt-2 w-full"
          onClick={() => void saveDescription()}
          disabled={savingNote || description === (session.description ?? "")}
        >
          {savingNote ? <Spinner /> : null}
          {noteSaved ? "Saved" : "Save note"}
        </button>
      </section>

      {/* --------------------------------------------------- ports & links */}
      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Ports and links
        </h2>
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
          Anything worth finding again. A port is also added to the forwarding command below.
        </p>

        <ul className="mt-3 space-y-2">
          {session.devPort ? (
            <li className="flex items-center gap-2 rounded-lg bg-[var(--bg-sunken)] p-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">Dev server</span>
                <span className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
                  port {session.devPort} · reserved automatically
                </span>
              </span>
              {session.appUrl ? (
                <a
                  className="btn btn-ghost shrink-0 px-3 text-[12px]"
                  href={session.appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                </a>
              ) : null}
            </li>
          ) : null}

          {session.links.map((link) => {
            const href = link.url ?? (link.port ? `http://${session.server.host}:${link.port}` : null);
            return (
              <li
                key={link.id}
                className="flex items-center gap-2 rounded-lg bg-[var(--bg-sunken)] p-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{link.label}</span>
                  <span className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
                    {link.port ? `port ${link.port}` : link.url}
                  </span>
                </span>
                {href ? (
                  <a
                    className="btn btn-ghost shrink-0 px-3 text-[12px]"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                  </a>
                ) : null}
                <button
                  className="btn btn-ghost shrink-0 px-2 text-[12px]"
                  onClick={() => void removeLink(link.id)}
                  aria-label={`Remove ${link.label}`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>

        <form onSubmit={addLink} className="mt-3 space-y-2">
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label — e.g. Admin panel"
          />
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <input
              className="field"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="Port"
              inputMode="numeric"
            />
            <input
              className="field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="…or a full URL"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <button
            type="submit"
            className="btn btn-secondary w-full"
            disabled={adding || !label.trim() || (!port.trim() && !url.trim())}
          >
            {adding ? <Spinner /> : null}
            Add
          </button>
        </form>

        {error ? (
          <p className="mt-2 text-[12px] leading-snug text-[var(--bad-fg)]">{error}</p>
        ) : null}
      </section>

      {/* ------------------------------------------------- work locally */}
      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Work from your own machine
        </h2>

        {forward.ports.length === 0 ? (
          <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">
            No ports to forward yet. Add one above, and the command appears here.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
              These ports live on the server&rsquo;s localhost. Run this on your laptop and they
              become <code className="font-mono">localhost</code> ports there too.
            </p>

            <div className="mt-3 flex gap-2">
              <button
                className={`btn flex-1 ${shell === "bash" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setShell("bash")}
              >
                macOS / Linux
              </button>
              <button
                className={`btn flex-1 ${shell === "powershell" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setShell("powershell")}
              >
                Windows
              </button>
            </div>

            <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={background}
                onChange={(e) => setBackground(e.target.checked)}
              />
              Run in the background, so the terminal stays free
            </label>

            <pre className="terminal mt-2 whitespace-pre-wrap break-all">{command}</pre>
            <button className="btn btn-secondary mt-2 w-full" onClick={() => void copy(command, "cmd")}>
              {copied === "cmd" ? "Copied" : "Copy command"}
            </button>

            <p className="mt-3 text-[12px] leading-snug text-[var(--text-muted)]">
              {shell === "bash"
                ? "Leave it running. Ctrl-C closes the tunnel."
                : "Windows 10 and 11 ship the ssh client, so this works in PowerShell as-is."}
            </p>

            <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
              Then reachable at
            </h3>
            <ul className="mt-2 space-y-1 text-[12px]">
              {forward.ports.map((p) => (
                <li key={p.port} className="flex gap-2">
                  <span className="w-40 shrink-0 truncate text-[var(--text-muted)]">{p.label}</span>
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {p.localUrl ? (
                      <a className="underline" href={p.localUrl} target="_blank" rel="noopener noreferrer">
                        {p.localUrl}
                      </a>
                    ) : (
                      `localhost:${p.localPort}`
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
