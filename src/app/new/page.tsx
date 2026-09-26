"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/components/LiveProvider";
import { Spinner } from "@/components/SessionCard";
import { normalizeProjectName } from "@/lib/shell";
import { SERVER_STATUS_UI, type ServerStatus } from "@/lib/claude/state";
import type { PublicResource } from "@/lib/resources";

type TemplateOption = {
  id: string;
  label: string;
  summary: string;
  needsServices: boolean;
  runs: boolean;
};

/**
 * The whole point of this screen on a phone: pick a server, type a name, tap
 * Start. Everything else is optional detail shown below the fold.
 */
export default function NewProjectPage() {
  const router = useRouter();
  const { servers, refresh } = useLive();
  const [serverId, setServerId] = useState<string>("");
  const [rawName, setRawName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<PublicResource[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [template, setTemplate] = useState("blank");

  const usable = useMemo(() => servers.filter((s) => s.active), [servers]);

  // Shared databases and object stores are optional; the defaults are
  // preselected so the common case stays server → name → start.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/resources", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { resources: PublicResource[] };
      const active = data.resources.filter((r) => r.active);
      setResources(active);
      setPicked(new Set(active.filter((r) => r.isDefault).map((r) => r.id)));
    })();

    void (async () => {
      const res = await fetch("/api/templates", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { templates: TemplateOption[] };
      setTemplates(data.templates);
    })();
  }, []);

  useEffect(() => {
    if (!serverId && usable.length > 0) {
      // Default to the first host that is actually reachable.
      const online = usable.find((s) => s.status === "ONLINE");
      setServerId((online ?? usable[0]).id);
    }
  }, [usable, serverId]);

  const projectName = normalizeProjectName(rawName);
  const server = usable.find((s) => s.id === serverId) ?? null;
  const canSubmit = Boolean(serverId) && projectName.length > 0 && !submitting;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, projectName, resourceIds: [...picked], template }),
      });
      const data = (await res.json()) as {
        session?: { id: string };
        error?: string;
      };
      if (!res.ok || !data.session) {
        setError(data.error ?? "The session could not be created.");
        setSubmitting(false);
        return;
      }
      await refresh();
      router.push(`/sessions/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (servers.length === 0) {
    return (
      <div className="card mt-6 p-6 text-center">
        <h1 className="text-[19px] font-semibold">Add a server first</h1>
        <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-[var(--text-muted)]">
          A project needs a host to run on.
        </p>
        <Link href="/servers/new" className="btn btn-primary btn-lg mt-5 w-full sm:w-auto sm:px-8">
          Add server
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-[14px] text-[var(--text-muted)]">
          Creates the folder, starts tmux, launches Claude Code with Remote Control.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Server
        </h2>
        <div className="grid gap-2">
          {usable.map((s) => {
            const status = SERVER_STATUS_UI[(s.status as ServerStatus) ?? "UNKNOWN"];
            const selected = s.id === serverId;
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setServerId(s.id)}
                aria-pressed={selected}
                className={`card flex items-center gap-3 p-4 text-left transition-colors ${
                  selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""
                }`}
              >
                <span
                  aria-hidden
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                    selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]"
                  }`}
                >
                  {selected ? <span className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{s.name}</span>
                  <span className="block truncate text-[12px] text-[var(--text-muted)]">
                    {s.projectRoot}
                  </span>
                </span>
                <span className={`pill ${status.className} shrink-0`}>
                  <span aria-hidden>{status.dot}</span>
                  {status.label}
                </span>
              </button>
            );
          })}
        </div>
        {usable.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            Every server is set to inactive. Activate one under Servers.
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <label
          htmlFor="projectName"
          className="block text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]"
        >
          Project name
        </label>
        <input
          id="projectName"
          className="field"
          value={rawName}
          onChange={(e) => setRawName(e.target.value)}
          placeholder="my-saas"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          inputMode="text"
        />
        {server ? (
          <p className="break-all text-[12px] text-[var(--text-muted)]">
            {projectName ? (
              <>
                Creates <code className="font-mono">{`${server.projectRoot}/${projectName}`}</code>
              </>
            ) : (
              <>
                Inside <code className="font-mono">{server.projectRoot}</code>
              </>
            )}
          </p>
        ) : null}
        {projectName && projectName !== rawName.trim() ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            Folder name will be <strong className="font-mono">{projectName}</strong>.
          </p>
        ) : null}
      </section>

      {templates.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
            Start from
          </h2>
          <div className="grid gap-2">
            {templates.map((option) => {
              const selected = option.id === template;
              return (
                <button
                  type="button"
                  key={option.id}
                  aria-pressed={selected}
                  onClick={() => setTemplate(option.id)}
                  className={`card flex items-center gap-3 p-4 text-left transition-colors ${
                    selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                      selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]"
                    }`}
                  >
                    {selected ? <span className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{option.label}</span>
                    <span className="block text-[12px] leading-snug text-[var(--text-muted)]">
                      {option.summary}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {resources.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
            Backing services
          </h2>
          <div className="grid gap-2">
            {resources.map((resource) => {
              const selected = picked.has(resource.id);
              return (
                <button
                  type="button"
                  key={resource.id}
                  aria-pressed={selected}
                  onClick={() =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(resource.id)) next.delete(resource.id);
                      else next.add(resource.id);
                      return next;
                    })
                  }
                  className={`card flex items-center gap-3 p-4 text-left transition-colors ${
                    selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${
                      selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border-strong)]"
                    }`}
                  >
                    {selected ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{resource.name}</span>
                    <span className="block truncate text-[12px] text-[var(--text-muted)]">
                      {resource.kind === "POSTGRES"
                        ? `Own database on ${resource.target}`
                        : resource.layout === "SHARED_BUCKET_PREFIX"
                          ? `Own prefix in ${resource.bucket}`
                          : "Own bucket"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">
            The credentials land in the project&rsquo;s <code className="font-mono">.env</code>, so
            Claude Code finds them without being told.
          </p>
        </section>
      ) : null}

      {error ? (
        <p className="card border-[var(--bad-fg)] p-3 text-[13px] leading-snug text-[var(--bad-fg)]">
          {error}
        </p>
      ) : null}

      {server && server.status !== "ONLINE" ? (
        <p className="card p-3 text-[13px] leading-snug text-[var(--warn-fg)]">
          {server.name} last reported {SERVER_STATUS_UI[(server.status as ServerStatus) ?? "UNKNOWN"].label.toLowerCase()}.
          Starting will probably fail until the host is reachable.
        </p>
      ) : null}

      {/* Sticky on mobile so the action is always under your thumb. */}
      <div className="sticky bottom-20 z-10 md:static">
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={!canSubmit}>
          {submitting ? <Spinner /> : null}
          {submitting ? "Starting…" : "Start session"}
        </button>
      </div>
    </form>
  );
}
