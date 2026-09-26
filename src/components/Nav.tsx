"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive } from "./LiveProvider";
import { needsAttention } from "@/lib/claude/state";

const TABS = [
  { href: "/", label: "Sessions", icon: SessionsIcon },
  { href: "/new", label: "New", icon: PlusIcon },
  { href: "/servers", label: "Servers", icon: ServerIcon },
  { href: "/resources", label: "Data", icon: DatabaseIcon },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/sessions");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopBar() {
  const pathname = usePathname();
  const { connected, sessions } = useLive();
  if (pathname === "/login") return null;

  const attention = sessions.filter((s) => needsAttention(s.state)).length;

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-[13px] font-bold text-[var(--accent-text)]"
          >
            NL
          </span>
          <span className="text-[15px]">NoLaptop</span>
        </Link>

        <span
          title={connected ? "Live updates connected" : "Reconnecting…"}
          className={`ml-1 h-2 w-2 shrink-0 rounded-full ${
            connected ? "bg-[var(--ok-fg)]" : "bg-[var(--warn-fg)]"
          }`}
        />

        <nav className="ml-auto hidden items-center gap-1 md:flex">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive(pathname, tab.href)
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {tab.label}
              {tab.href === "/" && attention > 0 ? (
                <span className="ml-1.5 rounded-full bg-[var(--warn-bg)] px-1.5 py-0.5 text-[11px] text-[var(--warn-fg)]">
                  {attention}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        {attention > 0 ? (
          <span className="pill pill-warn md:hidden" aria-label={`${attention} sessions need attention`}>
            {attention} to do
          </span>
        ) : null}
      </div>
    </header>
  );
}

export function TabBar() {
  const pathname = usePathname();
  const { sessions } = useLive();
  if (pathname === "/login") return null;
  const attention = sessions.filter((s) => needsAttention(s.state)).length;

  return (
    <nav className="tabbar md:hidden" aria-label="Main">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isActive(pathname, tab.href);
        return (
          <Link key={tab.href} href={tab.href} data-active={active}>
            <span className="relative">
              <Icon />
              {tab.href === "/" && attention > 0 ? (
                <span className="absolute -right-1.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--warn-fg)]" />
              ) : null}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

// --- icons ------------------------------------------------------------------

function SessionsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z" />
      <path d="M7 6.5h.01M7 17.5h.01" />
    </svg>
  );
}
