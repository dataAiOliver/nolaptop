/**
 * A tiny in-process pub/sub that feeds the Server-Sent Events endpoint.
 *
 * One Next.js process owns both the monitor and the SSE route, so an event
 * emitter is enough — no broker, no extra service.
 */

export type AppEvent =
  | { type: "sessions"; at: number }
  | { type: "servers"; at: number }
  | { type: "session"; sessionId: string; at: number }
  | { type: "toast"; level: "info" | "error"; message: string; at: number };

type Listener = (event: AppEvent) => void;

const globalForBus = globalThis as unknown as { nlListeners?: Set<Listener> };
const listeners: Set<Listener> = (globalForBus.nlListeners ??= new Set());

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: AppEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A broken client must not take the monitor down.
    }
  }
}

export function sessionsChanged(): void {
  publish({ type: "sessions", at: Date.now() });
}

export function serversChanged(): void {
  publish({ type: "servers", at: Date.now() });
}

export function sessionChanged(sessionId: string): void {
  publish({ type: "session", sessionId, at: Date.now() });
  publish({ type: "sessions", at: Date.now() });
}

export function subscriberCount(): number {
  return listeners.size;
}
