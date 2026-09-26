"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/SessionCard";
import { formatRelative } from "@/lib/format";
import type { PublicResource } from "@/lib/resources";

export default function ResourcesPage() {
  const [resources, setResources] = useState<PublicResource[] | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/resources", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { resources: PublicResource[] };
    setResources(data.resources);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!resources) {
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
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Resources</h1>
          <p className="mt-1 text-[14px] leading-snug text-[var(--text-muted)]">
            Shared databases and object stores. Each project gets its own namespace.
          </p>
        </div>
        <Link href="/resources/new" className="btn btn-primary ml-auto shrink-0">
          + Add
        </Link>
      </header>

      {resources.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-[14px] leading-relaxed text-[var(--text-muted)]">
            No shared services yet. Add a Postgres instance or an S3-compatible store, and new
            projects can get their own database and bucket with one tap — written straight into the
            project&rsquo;s <code className="font-mono">.env</code>.
          </p>
          <Link href="/resources/new" className="btn btn-primary btn-lg mt-5 w-full sm:w-auto sm:px-8">
            Add the first resource
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {resources.map((resource) => (
            <ResourceCard key={resource.id} resource={resource} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceCard({ resource, onChange }: { resource: PublicResource; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function probe() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/resources/${resource.id}/probe`, { method: "POST" });
      const data = (await res.json()) as { probe?: { ok: boolean; message: string }; error?: string };
      setNote(data.error ?? data.probe?.message ?? null);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const statusClass =
    resource.status === "ONLINE" ? "pill-ok" : resource.status === "ERROR" ? "pill-bad" : "pill-idle";

  return (
    <article className="card min-w-0 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight">{resource.name}</h2>
          <p className="mt-1 truncate font-mono text-[12px] text-[var(--text-muted)]">
            {resource.target}
          </p>
        </div>
        <span className={`pill ${statusClass} shrink-0`}>
          {resource.status === "ONLINE" ? "Reachable" : resource.status === "ERROR" ? "Error" : "Unchecked"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="pill pill-info">{resource.kind === "POSTGRES" ? "Postgres" : "S3"}</span>
        {resource.isDefault ? <span className="pill pill-idle">Default</span> : null}
        {!resource.active ? <span className="pill pill-warn">Inactive</span> : null}
        {resource.allocationCount ? (
          <span className="pill pill-idle">{resource.allocationCount} project(s)</span>
        ) : null}
      </div>

      {resource.description ? (
        <p className="mt-2 text-[13px] text-[var(--text-muted)]">{resource.description}</p>
      ) : null}
      {resource.statusMessage ? (
        <p className="mt-2 break-words text-[12px] leading-snug text-[var(--text-muted)]">
          {resource.statusMessage}
        </p>
      ) : null}
      {note ? (
        <p className="mt-2 break-words text-[12px] leading-snug text-[var(--text-muted)]">{note}</p>
      ) : null}
      <p className="mt-2 text-[12px] text-[var(--text-faint)]">
        Checked {formatRelative(resource.lastCheckAt)}
      </p>

      <div className="mt-3 flex gap-2">
        <button className="btn btn-secondary flex-1" onClick={() => void probe()} disabled={busy}>
          {busy ? <Spinner /> : null}
          Test
        </button>
        <Link className="btn btn-ghost flex-1" href={`/resources/${resource.id}`}>
          Edit
        </Link>
      </div>
    </article>
  );
}
