"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "./SessionCard";
import type { AllocationView, PublicResource } from "@/lib/resources";

/**
 * The backing services attached to one project.
 *
 * Secrets are not part of the normal payload — you have to ask for them, and
 * the request is separate so a screenshot of this page is harmless.
 */
const META_LABELS: Record<string, string> = {
  host: "Host",
  port: "Port",
  database: "Database",
  endpoint: "Endpoint",
  region: "Region",
  bucket: "Bucket",
  prefix: "Prefix",
  forcePathStyle: "Path style",
  accessKey: "Access key",
};

export function SessionResources({ sessionId }: { sessionId: string }) {
  const [allocations, setAllocations] = useState<AllocationView[]>([]);
  const [available, setAvailable] = useState<PublicResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, AllocationView>>({});

  const load = useCallback(async () => {
    const [allocRes, resourceRes] = await Promise.all([
      fetch(`/api/sessions/${sessionId}/resources`, { cache: "no-store" }),
      fetch("/api/resources", { cache: "no-store" }),
    ]);
    if (allocRes.ok) {
      const data = (await allocRes.json()) as { allocations: AllocationView[] };
      setAllocations(data.allocations);
    }
    if (resourceRes.ok) {
      const data = (await resourceRes.json()) as { resources: PublicResource[] };
      setAvailable(data.resources.filter((r) => r.active));
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function attach(resourceId: string) {
    setBusy(resourceId);
    setNote(null);
    const res = await fetch(`/api/sessions/${sessionId}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceIds: [resourceId] }),
    });
    const data = (await res.json()) as { allocations?: AllocationView[]; error?: string };
    if (!res.ok) setNote({ ok: false, message: data.error ?? "Could not reserve the namespace." });
    else setNote({ ok: true, message: "Reserved, and written to the project's .env." });
    await load();
    setBusy(null);
  }

  async function detach(allocation: AllocationView) {
    const destroy = window.confirm(
      `Detach ${allocation.namespace} from this project?\n\n` +
        "OK = also delete the data (drops the database / bucket — cannot be undone).\n" +
        "Cancel = keep the data and only detach.",
    );
    // A second, explicit confirmation before anything is destroyed.
    const reallyDestroy =
      destroy &&
      window.confirm(`Really delete ${allocation.namespace} and everything in it? This is permanent.`);

    setBusy(allocation.id);
    const res = await fetch(
      `/api/sessions/${sessionId}/resources?allocationId=${allocation.id}&destroy=${reallyDestroy ? "1" : "0"}`,
      { method: "DELETE" },
    );
    const data = (await res.json()) as { note?: string; error?: string };
    setNote({ ok: res.ok, message: data.error ?? data.note ?? "Detached." });
    await load();
    setBusy(null);
  }

  async function reveal(allocation: AllocationView) {
    setBusy(allocation.id);
    const res = await fetch(`/api/sessions/${sessionId}/resources?reveal=1`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { allocations: AllocationView[] };
      const found = data.allocations.find((a) => a.id === allocation.id);
      if (found) setRevealed((current) => ({ ...current, [allocation.id]: found }));
    }
    setBusy(null);
  }

  async function sync() {
    setBusy("sync");
    const res = await fetch(`/api/sessions/${sessionId}/resources/sync`, { method: "POST" });
    const data = (await res.json()) as { note?: string; error?: string };
    setNote({ ok: res.ok, message: data.error ?? data.note ?? "Written." });
    setBusy(null);
  }

  if (loading) {
    return (
      <section className="card p-4">
        <div className="skeleton h-4 w-1/3" />
      </section>
    );
  }

  const attachable = available.filter((r) => !allocations.some((a) => a.resourceId === r.id));

  return (
    <section className="card p-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
        Backing services
      </h2>

      {allocations.length === 0 ? (
        <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">
          No database or object store attached.{" "}
          {available.length === 0 ? (
            <>
              Add one under <Link href="/resources" className="underline">Data</Link> first.
            </>
          ) : null}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {allocations.map((allocation) => {
            const secrets = revealed[allocation.id];
            return (
              <li key={allocation.id} className="rounded-xl bg-[var(--bg-sunken)] p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{allocation.resourceName}</p>
                    <p className="mt-0.5 break-all font-mono text-[12px] text-[var(--text-muted)]">
                      {allocation.namespace || "—"}
                    </p>
                  </div>
                  <span
                    className={`pill shrink-0 ${allocation.state === "READY" ? "pill-ok" : "pill-bad"}`}
                  >
                    {allocation.state === "READY" ? "Ready" : "Error"}
                  </span>
                </div>

                {allocation.error ? (
                  <p className="mt-2 break-words text-[12px] leading-snug text-[var(--bad-fg)]">
                    {allocation.error}
                  </p>
                ) : null}

                {allocation.state === "READY" ? (
                  <dl className="mt-2 space-y-1 text-[12px]">
                    {Object.entries(allocation.meta).map(([key, value]) =>
                      value === null || value === "" || key === "dedicatedKey" ? null : (
                        <div key={key} className="flex gap-2">
                          <dt className="w-24 shrink-0 text-[var(--text-faint)]">{META_LABELS[key] ?? key}</dt>
                          <dd className="min-w-0 flex-1 break-all font-mono">{String(value)}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : null}

                {allocation.state === "READY" && allocation.meta.dedicatedKey === false ? (
                  <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">
                    The bucket is this project&rsquo;s own; the access key is the store&rsquo;s
                    shared key, not one scoped to this bucket.
                  </p>
                ) : null}

                {secrets?.secret ? (
                  <div className="mt-2">
                    <p className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
                      {allocation.kind === "POSTGRES" ? "Connection string" : "Secret key"}
                    </p>
                    <p className="mt-1 break-all rounded-lg bg-[var(--bg-elevated)] p-2 font-mono text-[11px]">
                      {secrets.secret}
                    </p>
                    <button
                      className="btn btn-ghost mt-1 w-full"
                      onClick={() => void navigator.clipboard.writeText(secrets.secret ?? "")}
                    >
                      Copy
                    </button>
                  </div>
                ) : null}

                <div className="mt-2 flex gap-2">
                  {allocation.state === "READY" && !secrets ? (
                    <button
                      className="btn btn-ghost flex-1"
                      onClick={() => void reveal(allocation)}
                      disabled={busy !== null}
                    >
                      {busy === allocation.id ? <Spinner /> : null}
                      Show credentials
                    </button>
                  ) : null}
                  <button
                    className="btn btn-ghost flex-1"
                    onClick={() => void detach(allocation)}
                    disabled={busy !== null}
                  >
                    Detach
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {attachable.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {attachable.map((resource) => (
            <button
              key={resource.id}
              className="btn btn-secondary flex-1"
              onClick={() => void attach(resource.id)}
              disabled={busy !== null}
            >
              {busy === resource.id ? <Spinner /> : null}+ {resource.name}
            </button>
          ))}
        </div>
      ) : null}

      {allocations.length > 0 ? (
        <button
          className="btn btn-ghost mt-2 w-full"
          onClick={() => void sync()}
          disabled={busy !== null}
        >
          {busy === "sync" ? <Spinner /> : null}
          Rewrite .env on the server
        </button>
      ) : null}

      {note ? (
        <p
          className={`mt-2 text-[12px] leading-snug ${
            note.ok ? "text-[var(--text-muted)]" : "text-[var(--bad-fg)]"
          }`}
        >
          {note.message}
        </p>
      ) : null}
    </section>
  );
}
