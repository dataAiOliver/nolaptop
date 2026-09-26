"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "./SessionCard";
import { useLive } from "./LiveProvider";
import type { PublicServer } from "@/lib/servers";
import { EDITOR_MODES, EDITOR_MODE_UI, type EditorMode } from "@/lib/editor";

type Props = { existing?: PublicServer };

type ProbeState = { status: string; message: string | null; claudeVersion: string | null; tmuxVersion: string | null } | null;

export function ServerForm({ existing }: Props) {
  const router = useRouter();
  const { refreshServers } = useLive();

  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [projectRoot, setProjectRoot] = useState(existing?.projectRoot ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [active, setActive] = useState(existing?.active ?? true);

  const [agentsFileName, setAgentsFileName] = useState(existing?.agentsFileName ?? "AGENTS.md");
  const [agentsPreamble, setAgentsPreamble] = useState(existing?.agentsPreamble ?? "");

  const [editorMode, setEditorMode] = useState<EditorMode>(
    (existing?.editorMode as EditorMode) ?? "NONE",
  );
  const [editorBaseUrl, setEditorBaseUrl] = useState(existing?.editorBaseUrl ?? "");
  const [editorTunnelName, setEditorTunnelName] = useState(existing?.editorTunnelName ?? "");
  const [editorSshHost, setEditorSshHost] = useState(existing?.editorSshHost ?? "");
  const [editorUrlTemplate, setEditorUrlTemplate] = useState(existing?.editorUrlTemplate ?? "");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProbeState>(null);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(existing);
  const canSubmit =
    name.trim() &&
    host.trim() &&
    username.trim() &&
    projectRoot.trim() &&
    (isEdit || privateKey.trim()) &&
    !saving;

  async function test() {
    setTesting(true);
    setProbe(null);
    setError(null);
    try {
      const res = await fetch("/api/servers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 22,
          username: username.trim(),
          privateKey: privateKey.trim() || undefined,
          passphrase: passphrase || undefined,
          projectRoot: projectRoot.trim(),
          serverId: existing?.id,
        }),
      });
      const data = (await res.json()) as { probe?: ProbeState; error?: string };
      if (!res.ok) setError(data.error ?? "The connection test failed.");
      else setProbe(data.probe ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);

    const payload: Record<string, unknown> = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      projectRoot: projectRoot.trim(),
      description: description.trim() || null,
      active,
    };
    payload.agentsFileName = agentsFileName;
    payload.agentsPreamble = agentsPreamble.trim() || null;
    payload.editorMode = editorMode;
    payload.editorBaseUrl = editorBaseUrl.trim() || null;
    payload.editorTunnelName = editorTunnelName.trim() || null;
    payload.editorSshHost = editorSshHost.trim() || null;
    payload.editorUrlTemplate = editorUrlTemplate.trim() || null;

    if (privateKey.trim()) payload.privateKey = privateKey.trim();
    if (passphrase) payload.passphrase = passphrase;

    try {
      const res = await fetch(isEdit ? `/api/servers/${existing?.id}` : "/api/servers", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "The server could not be saved.");
        setSaving(false);
        return;
      }
      await refreshServers();
      router.push("/servers");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    if (!window.confirm(`Remove "${existing.name}"? Sessions on the host keep running.`)) return;
    setSaving(true);
    const res = await fetch(`/api/servers/${existing.id}`, { method: "DELETE" });
    const data = (await res.json()) as { error?: string; note?: string | null };
    if (!res.ok) {
      setError(data.error ?? "The server could not be removed.");
      setSaving(false);
      return;
    }
    await refreshServers();
    router.push("/servers");
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex items-center gap-2">
        <Link href="/servers" className="btn btn-ghost -ml-3 px-3">
          ← Servers
        </Link>
      </div>

      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">
          {isEdit ? existing?.name : "Add server"}
        </h1>
        <p className="mt-1 text-[14px] text-[var(--text-muted)]">
          The host needs <code className="font-mono">tmux</code> and the{" "}
          <code className="font-mono">claude</code> CLI, signed in to your Anthropic account.
        </p>
      </header>

      <Field label="Name" hint="How it shows up in the app.">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hetzner Dev 01" autoComplete="off" />
      </Field>

      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field label="Host">
          <input className="field" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </Field>
        <Field label="Port">
          <input className="field" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="22" />
        </Field>
      </div>

      <Field label="SSH user">
        <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </Field>

      <Field
        label="Project root"
        hint="Every project is created inside this directory — and nowhere else."
      >
        <input className="field font-mono text-[14px]" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} placeholder="/home/deploy/projects" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </Field>

      <Field
        label={isEdit ? "SSH private key (leave empty to keep)" : "SSH private key"}
        hint="Stored AES-256-GCM encrypted. It is never sent back to the browser."
      >
        <textarea
          className="field min-h-32 font-mono text-[12px]"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
          spellCheck={false}
          autoCapitalize="none"
        />
      </Field>

      <Field label="Key passphrase (optional)">
        <input
          className="field"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
      </Field>

      <Field label="Description (optional)">
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Staging box, 8 cores" />
      </Field>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Agent instructions
        </h2>
        <p className="text-[12px] leading-snug text-[var(--text-muted)]">
          Every project gets this file, describing its database, bucket, dev port and host — so the
          agent does not have to be told.
        </p>
        <select
          className="field"
          value={agentsFileName}
          onChange={(e) => setAgentsFileName(e.target.value)}
        >
          <option value="AGENTS.md">AGENTS.md — read by Claude Code, Codex, Cursor, Gemini</option>
          <option value="CLAUDE.md">CLAUDE.md — Claude Code only</option>
        </select>
        <p className="text-[12px] leading-snug text-[var(--text-muted)]">
          Only one is written. A CLAUDE.md in a project makes Claude Code ignore AGENTS.md
          entirely, so keeping both is a good way to lose your context silently.
        </p>
        <Field
          label="House rules (optional)"
          hint="Copied into every project's instructions. Package manager, test command, code style — whatever you would otherwise repeat."
        >
          <textarea
            className="field min-h-24 text-[13px]"
            value={agentsPreamble}
            onChange={(e) => setAgentsPreamble(e.target.value)}
            placeholder={"- Use pnpm, not npm.\n- Run `pnpm test` before saying you are done.\n- Commit messages in English, imperative mood."}
          />
        </Field>
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Open in VS Code
        </h2>
        <p className="text-[12px] leading-snug text-[var(--text-muted)]">
          Adds a button on every session card that jumps straight into that project.
        </p>
        <select
          className="field"
          value={editorMode}
          onChange={(e) => setEditorMode(e.target.value as EditorMode)}
        >
          {EDITOR_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {EDITOR_MODE_UI[mode].label}
              {EDITOR_MODE_UI[mode].browser ? " — in the browser" : ""}
            </option>
          ))}
        </select>
        <p className="text-[12px] leading-snug text-[var(--text-muted)]">
          {EDITOR_MODE_UI[editorMode].hint}
        </p>

        {editorMode === "TUNNEL" ? (
          <Field
            label="Tunnel machine name"
            hint="Run `code tunnel --name <name>` on the host. Links become vscode.dev/tunnel/<name>/<path>."
          >
            <input className="field font-mono text-[14px]" value={editorTunnelName} onChange={(e) => setEditorTunnelName(e.target.value)} placeholder="my-server" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        ) : null}

        {editorMode === "CODE_SERVER" ? (
          <Field label="code-server base URL" hint="The project path is appended as ?folder=…">
            <input className="field font-mono text-[14px]" value={editorBaseUrl} onChange={(e) => setEditorBaseUrl(e.target.value)} placeholder="https://code.example.com" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        ) : null}

        {editorMode === "DESKTOP_SSH" ? (
          <Field
            label="SSH host alias (optional)"
            hint="The name from your own ~/.ssh/config. Defaults to this server's address."
          >
            <input className="field font-mono text-[14px]" value={editorSshHost} onChange={(e) => setEditorSshHost(e.target.value)} placeholder="my-server" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        ) : null}

        {editorMode === "CUSTOM" ? (
          <Field label="URL template" hint="{path}, {pathEncoded} and {project} are substituted.">
            <input className="field font-mono text-[13px]" value={editorUrlTemplate} onChange={(e) => setEditorUrlTemplate(e.target.value)} placeholder="https://ide.example.com/?dir={pathEncoded}" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        ) : null}
      </section>

      <label className="card flex items-center gap-3 p-4">
        <input
          type="checkbox"
          className="h-5 w-5 accent-[var(--accent)]"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <span className="text-[14px]">
          Active
          <span className="block text-[12px] text-[var(--text-muted)]">
            Inactive servers are not probed and cannot take new projects.
          </span>
        </span>
      </label>

      {probe ? (
        <div className={`card p-3 text-[13px] leading-snug ${probe.status === "ONLINE" ? "" : "border-[var(--bad-fg)]"}`}>
          <p className={probe.status === "ONLINE" ? "text-[var(--ok-fg)]" : "text-[var(--bad-fg)]"}>
            {probe.status === "ONLINE" ? "Connection works." : `Connection failed (${probe.status}).`}
          </p>
          {probe.status === "ONLINE" ? (
            <p className="mt-1 text-[var(--text-muted)]">
              claude {probe.claudeVersion ?? "not found"} · {probe.tmuxVersion ?? "tmux not found"}
            </p>
          ) : null}
          {probe.message ? (
            <p className="mt-1 break-words text-[var(--text-muted)]">{probe.message}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="card border-[var(--bad-fg)] p-3 text-[13px] leading-snug text-[var(--bad-fg)]">
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-20 z-10 flex flex-col gap-2 md:static">
        <button
          type="button"
          className="btn btn-secondary btn-lg w-full"
          onClick={() => void test()}
          disabled={testing || !host.trim() || !username.trim() || (!isEdit && !privateKey.trim())}
        >
          {testing ? <Spinner /> : null}
          Test connection
        </button>
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={!canSubmit}>
          {saving ? <Spinner /> : null}
          {isEdit ? "Save changes" : "Add server"}
        </button>
      </div>

      {isEdit ? (
        <button type="button" className="btn btn-danger w-full" onClick={() => void remove()} disabled={saving}>
          Remove server
        </button>
      ) : null}
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="block text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[12px] leading-snug text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}
