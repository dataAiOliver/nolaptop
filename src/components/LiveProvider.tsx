"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDto } from "@/lib/serialize";
import type { PublicServer } from "@/lib/servers";

/**
 * One SSE connection for the whole app.
 *
 * The stream only carries "something changed" notices; the actual data is
 * re-fetched over plain JSON. That keeps the server side trivial and means a
 * dropped connection degrades to a slow refresh rather than a stale screen.
 */

type LiveValue = {
  sessions: SessionDto[];
  servers: PublicServer[];
  loading: boolean;
  connected: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshServers: () => Promise<void>;
};

const LiveContext = createContext<LiveValue | null>(null);

const POLL_FALLBACK_MS = 20_000;

/** Pages that exist precisely because there is no session yet. */
const PUBLIC_PATHS = ["/login", "/setup"];

function onPublicPage(): boolean {
  if (typeof window === "undefined") return false;
  return PUBLIC_PATHS.includes(window.location.pathname);
}

/**
 * Send the browser to the sign-in page — unless it is already on one of the
 * pages that does not need a session, which would otherwise reload forever.
 */
function redirectToLogin(): void {
  if (onPublicPage()) return;
  window.location.href = "/login";
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [servers, setServers] = useState<PublicServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const loadSessions = useCallback(async () => {
    if (inFlight.current || onPublicPage()) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) throw new Error(`Sessions could not be loaded (${res.status}).`);
      const data = (await res.json()) as { sessions: SessionDto[] };
      setSessions(data.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  const loadServers = useCallback(async () => {
    if (onPublicPage()) return;
    try {
      const res = await fetch("/api/servers", { cache: "no-store" });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { servers: PublicServer[] };
      setServers(data.servers);
    } catch {
      // The banner from loadSessions is enough; do not double-report.
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadServers();
  }, [loadSessions, loadServers]);

  // --- live stream ---------------------------------------------------------
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed || onPublicPage()) return;
      source = new EventSource("/api/events");

      source.addEventListener("open", () => setConnected(true));
      source.addEventListener("sessions", () => void loadSessions());
      source.addEventListener("session", () => void loadSessions());
      source.addEventListener("servers", () => void loadServers());

      source.addEventListener("error", () => {
        setConnected(false);
        source?.close();
        // EventSource retries by itself, but only for network errors — a 401
        // closes for good, so schedule our own attempt too.
        if (!closed) retry = setTimeout(connect, 5000);
      });
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [loadSessions, loadServers]);

  // --- fallback polling ----------------------------------------------------
  // Phones suspend timers and sockets when the screen locks. Re-sync whenever
  // the app comes back to the foreground, and keep a slow poll as a safety net.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void loadSessions();
        void loadServers();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions();
    }, POLL_FALLBACK_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(timer);
    };
  }, [loadSessions, loadServers]);

  const value = useMemo<LiveValue>(
    () => ({
      sessions,
      servers,
      loading,
      connected,
      error,
      refresh: loadSessions,
      refreshServers: loadServers,
    }),
    [sessions, servers, loading, connected, error, loadSessions, loadServers],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside LiveProvider.");
  return ctx;
}
