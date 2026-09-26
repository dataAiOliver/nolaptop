"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner } from "./SessionCard";

/**
 * The shared services on one host: is Postgres up, is the object store up, and
 * a button to start them if not.
 *
 * This is the step that turns "start a session" into "start a *configured*
 * session": with these running, a new project can be handed its own database
 * and bucket without you setting anything up first.
 */

type StackStatus = {
  kind: "POSTGRES" | "S3";
  dockerAvailable: boolean;
  exists: boolean;
  running: boolean;
  port: number | null;
  image: string | null;
  detail: string | null;
};

type StackResponse = {
  stack: { POSTGRES: StackStatus; S3: StackStatus };
  resources: { id: string; kind: string; name: string; status: string }[];
};

const LABELS = {
  POSTGRES: {
    title: "PostgreSQL",
    blurb: "Not set up. Enable to give each project its own database.",
  },
  S3: {
    title: "Object storage",
    blurb: "Not set up. Enable to give each project its own S3 bucket.",
  },
} as const;

export function ServerStack({ serverId, onChange }: { serverId: string; onChange?: () => void }) {
  const [data, setData] = useState<StackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/stack`, { cache: "no-store" });
      if (!res.ok) {
        setData(null);
        return;
      }
      setData((await res.json()) as StackResponse);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function enable(kind: "POSTGRES" | "S3") {
    setBusy(kind);
    setNote(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/stack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const body = (await res.json()) as { error?: string; created?: boolean };
      setNote(
        res.ok
          ? {
              ok: true,
              message: body.created
                ? "Started and registered. New projects can use it right away."
                : "Already there — registered and running.",
            }
          : { ok: false, message: body.error ?? "Could not start the service." },
      );
      await load();
      onChange?.();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="mt-3 rounded-xl bg-[var(--bg-sunken)] p-3">
        <div className="skeleton h-3 w-1/3" />
      </div>
    );
  }
  if (!data) return null;

  const dockerMissing = !data.stack.POSTGRES.dockerAvailable;

  return (
    <div className="mt-3 rounded-xl bg-[var(--bg-sunken)] p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
        Shared services — optional
      </h3>
      <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
        Off by default. Enabling starts one container on this host that every project then carves a
        namespace out of — its own database and bucket, with credentials written into the
        project&rsquo;s <code className="font-mono">.env</code>. Projects work fine without this.
      </p>

      {dockerMissing ? (
        <p className="mt-2 text-[12px] leading-snug text-[var(--text-muted)]">
          Docker was not found on this host, so NoLaptop cannot start them here. You can still point
          a resource at a database elsewhere under <strong>Data</strong>.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {(["POSTGRES", "S3"] as const).map((kind) => {
            const status = data.stack[kind];
            const registered = data.resources.find((r) => r.kind === kind);
            const label = LABELS[kind];
            return (
              <li key={kind} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{label.title}</span>
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">
                    {status.running
                      ? `Running on localhost:${status.port ?? "?"}${registered ? "" : " — not registered"}`
                      : label.blurb}
                  </span>
                </span>

                {status.running && registered ? (
                  <span className="pill pill-ok shrink-0">Active</span>
                ) : (
                  <button
                    className="btn btn-secondary shrink-0 px-3 text-[12px]"
                    onClick={() => void enable(kind)}
                    disabled={busy !== null}
                  >
                    {busy === kind ? <Spinner /> : null}
                    {status.exists ? "Start" : "Enable"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {note ? (
        <p
          className={`mt-2 text-[11px] leading-snug ${
            note.ok ? "text-[var(--text-muted)]" : "text-[var(--bad-fg)]"
          }`}
        >
          {note.message}
        </p>
      ) : null}

      {!dockerMissing ? (
        <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">
          Bound to this host&rsquo;s localhost and reached over SSH — nothing is exposed to the
          network.
        </p>
      ) : null}
    </div>
  );
}
