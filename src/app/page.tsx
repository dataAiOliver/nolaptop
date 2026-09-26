"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLive } from "@/components/LiveProvider";
import { SessionCard } from "@/components/SessionCard";
import { isLive, needsAttention, STATE_UI } from "@/lib/claude/state";

type Filter = "attention" | "live" | "all";

export default function Dashboard() {
  const { sessions, servers, loading, error } = useLive();
  const [filter, setFilter] = useState<Filter>("live");

  const counts = useMemo(
    () => ({
      attention: sessions.filter((s) => needsAttention(s.state)).length,
      live: sessions.filter((s) => isLive(s.state)).length,
      all: sessions.length,
    }),
    [sessions],
  );

  const visible = useMemo(() => {
    const list = sessions.filter((s) => {
      if (filter === "attention") return needsAttention(s.state);
      if (filter === "live") return isLive(s.state);
      return true;
    });
    // Whatever needs a decision floats to the top; then the connected ones.
    const rank = (state: string) =>
      needsAttention(state as never) ? 0 : isLive(state as never) ? 1 : 2;
    return [...list].sort(
      (a, b) =>
        rank(a.state) - rank(b.state) ||
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [sessions, filter]);

  if (loading) return <SkeletonList />;

  if (servers.length === 0) {
    return (
      <EmptyState
        title="No servers yet"
        body="Add the first Linux host that runs Claude Code. You need its SSH details and the directory your projects live in."
        cta={{ href: "/servers/new", label: "Add server" }}
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        body="Pick a server, type a project name, and Claude Code starts in a tmux session with Remote Control switched on."
        cta={{ href: "/new", label: "New project" }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="card border-[var(--bad-fg)] p-3 text-[13px] text-[var(--bad-fg)]">{error}</p>
      ) : null}

      <div className="flex items-center gap-2">
        {/* The chips scroll on their own; a button pinned inside a scroll
            container would be clipped off the right edge on a phone. */}
        <div className="-mx-4 flex flex-1 items-center gap-2 overflow-x-auto px-4 pb-1">
          <FilterChip active={filter === "live"} onClick={() => setFilter("live")}>
            Active {counts.live > 0 ? `(${counts.live})` : ""}
          </FilterChip>
          <FilterChip active={filter === "attention"} onClick={() => setFilter("attention")}>
            Needs you {counts.attention > 0 ? `(${counts.attention})` : ""}
          </FilterChip>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All ({counts.all})
          </FilterChip>
        </div>
        {/* On a phone the bottom tab bar already carries "New". */}
        <Link href="/new" className="btn btn-primary hidden shrink-0 md:inline-flex">
          + New
        </Link>
      </div>

      {visible.length === 0 ? (
        <p className="card p-6 text-center text-[14px] text-[var(--text-muted)]">
          {filter === "attention"
            ? "Nothing is waiting on you right now."
            : "No sessions in this view."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}

      <StateLegend />
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`btn shrink-0 ${active ? "btn-primary" : "btn-secondary"}`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function SkeletonList() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card p-4">
          <div className="skeleton h-5 w-2/5" />
          <div className="skeleton mt-2 h-3 w-3/5" />
          <div className="skeleton mt-4 h-12 w-full" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta: { href: string; label: string };
}) {
  return (
    <div className="card mt-6 p-6 text-center">
      <h1 className="text-[19px] font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-[var(--text-muted)]">
        {body}
      </p>
      <Link href={cta.href} className="btn btn-primary btn-lg mt-5 w-full sm:w-auto sm:px-8">
        {cta.label}
      </Link>
    </div>
  );
}

function StateLegend() {
  return (
    <details className="card p-4 text-[13px] text-[var(--text-muted)]">
      <summary className="cursor-pointer font-medium text-[var(--text)]">
        What the states mean
      </summary>
      <ul className="mt-3 space-y-2">
        {Object.entries(STATE_UI).map(([state, ui]) => (
          <li key={state} className="flex items-start gap-2">
            <span className={`pill ${ui.className} mt-0.5 shrink-0`}>
              <span aria-hidden>{ui.dot}</span>
              {ui.label}
            </span>
            <span className="leading-snug">{ui.hint}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
