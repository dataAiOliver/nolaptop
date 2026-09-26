"use client";

import Link from "next/link";
import { useState } from "react";
import { useLive } from "@/components/LiveProvider";
import { Spinner } from "@/components/SessionCard";
import { SERVER_STATUS_UI, type ServerStatus } from "@/lib/claude/state";
import { formatRelative } from "@/lib/format";
import type { PublicServer } from "@/lib/servers";
import { ServerStack } from "@/components/ServerStack";
import { ServerVsCode } from "@/components/ServerVsCode";

export default function ServersPage() {
  const { servers, loading, refreshServers } = useLive();

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-7 w-1/3" />
        <div className="skeleton h-28 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Servers</h1>
          <p className="mt-1 text-[14px] text-[var(--text-muted)]">
            Hosts that run tmux and Claude Code.
          </p>
        </div>
        <Link href="/servers/new" className="btn btn-primary ml-auto shrink-0">
          + Add
        </Link>
      </header>

      {servers.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-[14px] text-[var(--text-muted)]">No servers configured yet.</p>
          <Link href="/servers/new" className="btn btn-primary btn-lg mt-4 w-full sm:w-auto sm:px-8">
            Add the first server
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} onChange={refreshServers} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerCard({ server, onChange }: { server: PublicServer; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const status = SERVER_STATUS_UI[(server.status as ServerStatus) ?? "UNKNOWN"];

  async function probe() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/probe`, { method: "POST" });
      const data = (await res.json()) as { probe?: { status: string; message: string | null }; error?: string };
      setNote(data.error ?? data.probe?.message ?? "Reachable, everything in place.");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function forgetHostKey() {
    if (
      !window.confirm(
        "Forget the pinned SSH host key?\n\nOnly do this if you know the host was rebuilt. " +
          "The next connection will trust whatever key the server presents.",
      )
    ) {
      return;
    }
    setBusy(true);
    await fetch(`/api/servers/${server.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetHostKey: true }),
    });
    setNote("Host key forgotten. It will be pinned again on the next connection.");
    onChange();
    setBusy(false);
  }

  async function toggleActive() {
    setBusy(true);
    await fetch(`/api/servers/${server.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !server.active }),
    });
    onChange();
    setBusy(false);
  }

  return (
    <article className="card min-w-0 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight">{server.name}</h2>
          <p className="mt-1 truncate font-mono text-[12px] text-[var(--text-muted)]">
            {server.username}@{server.host}:{server.port}
          </p>
        </div>
        <span className={`pill ${status.className} shrink-0`}>
          <span aria-hidden>{status.dot}</span>
          {status.label}
        </span>
      </div>

      <dl className="mt-3 space-y-1 text-[12px]">
        <Row label="Project root" value={server.projectRoot} mono />
        <Row label="Claude CLI" value={server.claudeVersion ?? "Not detected"} />
        <Row label="tmux" value={server.tmuxVersion ?? "Not detected"} />
        <Row
          label="Claude account"
          value={
            server.claudeAuth
              ? server.claudeAuth.loggedIn
                ? `${server.claudeAuth.email ?? "signed in"}${
                    server.claudeAuth.subscriptionType ? ` · ${server.claudeAuth.subscriptionType}` : ""
                  }`
                : "Not signed in"
              : "Unknown"
          }
        />
        <Row
          label="Host key"
          value={server.hostKeyFingerprint ?? "Not pinned yet"}
          mono={Boolean(server.hostKeyFingerprint)}
        />
        <Row label="Last check" value={formatRelative(server.lastCheckAt)} />
        {server.sessionCount !== undefined ? (
          <Row label="Sessions" value={String(server.sessionCount)} />
        ) : null}
      </dl>

      {server.statusMessage ? (
        <p className="mt-2 break-words text-[12px] leading-snug text-[var(--warn-fg)]">
          {server.statusMessage}
        </p>
      ) : null}
      {note ? (
        <p className="mt-2 break-words text-[12px] leading-snug text-[var(--text-muted)]">{note}</p>
      ) : null}

      {server.status === "ONLINE" ? (
        <>
          <ServerStack serverId={server.id} onChange={onChange} />
          <ServerVsCode serverId={server.id} onChange={onChange} />
        </>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button className="btn btn-secondary flex-1" onClick={() => void probe()} disabled={busy}>
          {busy ? <Spinner /> : null}
          Test
        </button>
        <button className="btn btn-ghost flex-1" onClick={() => void toggleActive()} disabled={busy}>
          {server.active ? "Deactivate" : "Activate"}
        </button>
        <Link className="btn btn-ghost flex-1" href={`/servers/${server.id}`}>
          Edit
        </Link>
      </div>

      {server.hostKeyFingerprint ? (
        <button
          className="btn btn-ghost mt-1 w-full text-[12px]"
          onClick={() => void forgetHostKey()}
          disabled={busy}
        >
          Forget pinned host key
        </button>
      ) : null}
    </article>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-[var(--text-faint)]">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
