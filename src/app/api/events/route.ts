import { NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { subscribe } from "@/lib/events";
import { startMonitor } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: the dashboard subscribes once and re-fetches whatever the
 * monitor says has changed. Cheaper than polling and it survives a phone
 * locking its screen, because EventSource reconnects on its own.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return new Response("Not signed in.", { status: 401 });
  }
  startMonitor();

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown, event = "message") => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };

      send({ type: "hello", at: Date.now() });
      unsubscribe = subscribe((event) => send(event, event.type));

      // Proxies drop a silent stream; a comment every 20s keeps it open.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 20_000);
      heartbeat.unref?.();

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
