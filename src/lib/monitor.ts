import { prisma } from "./db";
import { probeServer } from "./servers";
import { refreshSession } from "./sessions";
import { isLive } from "./claude/state";
import { reapIdleConnections } from "./ssh";
import { reapIdleTunnels } from "./tunnel";
import { sessionsChanged } from "./events";

/**
 * The background health monitor.
 *
 * It is what makes the dashboard trustworthy: no state is believed because the
 * database says so, it is re-derived from tmux and the Claude process on every
 * tick. The loop is deliberately conservative — it observes and records, it
 * never restarts or kills anything on its own.
 */

const DEFAULT_INTERVAL_MS = 15_000;
/** Offline and stopped sessions are checked far less often. */
const IDLE_MULTIPLIER = 4;

type MonitorState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
  tick: number;
  lastRunAt: number | null;
  lastError: string | null;
};

const globalForMonitor = globalThis as unknown as { nlMonitor?: MonitorState };
const state: MonitorState = (globalForMonitor.nlMonitor ??= {
  timer: null,
  running: false,
  tick: 0,
  lastRunAt: null,
  lastError: null,
});

function intervalMs(): number {
  const raw = Number(process.env.NL_MONITOR_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 5000 ? raw : DEFAULT_INTERVAL_MS;
}

export function startMonitor(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void runTick();
  }, intervalMs());
  // Do not hold the process open just for the monitor.
  state.timer.unref?.();
  void runTick();
}

export function monitorStatus() {
  return {
    running: Boolean(state.timer),
    tick: state.tick,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastError: state.lastError,
    intervalMs: intervalMs(),
  };
}

async function runTick(): Promise<void> {
  if (state.running) return; // A slow host must not pile up ticks.
  state.running = true;
  state.tick += 1;
  const tick = state.tick;

  try {
    const servers = await prisma.server.findMany({ include: { sessions: true } });
    let changed = false;

    for (const server of servers) {
      if (!server.active) continue;

      // Probe every host on every 4th tick, and immediately when it was down.
      const needsProbe =
        tick % IDLE_MULTIPLIER === 1 || server.status !== "ONLINE" || !server.lastCheckAt;
      if (needsProbe) {
        const probe = await probeServer(server);
        if (probe.status !== "ONLINE") {
          // Mark this server's live sessions as unreachable rather than guessing.
          const affected = server.sessions.filter((s) => isLive(s.state as never));
          for (const session of affected) {
            if (session.state === "SERVER_OFFLINE") continue;
            await prisma.session.update({
              where: { id: session.id },
              data: { state: "SERVER_OFFLINE", stateDetail: probe.message?.slice(0, 500) ?? null },
            });
            changed = true;
          }
          continue;
        }
      }

      const fresh = await prisma.server.findUnique({ where: { id: server.id } });
      if (!fresh || fresh.status !== "ONLINE") continue;

      for (const session of server.sessions) {
        const live = isLive(session.state as never);
        if (!live && tick % IDLE_MULTIPLIER !== 1) continue;
        const before = session.state;
        const current = await prisma.session.findUnique({ where: { id: session.id } });
        if (!current) continue;
        const obs = await refreshSession(fresh, current);
        if (obs.state !== before) changed = true;
      }
    }

    if (changed) sessionsChanged();
    reapIdleConnections();
    reapIdleTunnels();
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    state.lastRunAt = Date.now();
    state.running = false;
  }
}
