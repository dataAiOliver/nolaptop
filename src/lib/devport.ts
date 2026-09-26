import type { Server } from "@prisma/client";
import { prisma } from "./db";
import { sshExec } from "./ssh";

/**
 * A port reserved for each project's dev server.
 *
 * On a machine running several agents at once, `npm run dev` picking 3000 every
 * time is a guaranteed collision — and a confusing one, because the second
 * project silently serves the first one's app. So each project gets a port up
 * front, written into its `.env` as `PORT` and stated in its instructions file.
 */

const RANGE_START = 3100;
const RANGE_END = 3999;

/** Ports already listening on the host, so we never hand out a used one. */
async function portsInUse(server: Server): Promise<Set<number>> {
  const res = await sshExec(
    server,
    `ss -tln 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -E '^[0-9]+$' || true`,
    { timeoutMs: 15_000 },
  );
  const used = new Set<number>();
  for (const line of res.stdout.split("\n")) {
    const port = Number(line.trim());
    if (Number.isInteger(port)) used.add(port);
  }
  return used;
}

export async function allocateDevPort(server: Server, sessionId: string): Promise<number | null> {
  const taken = await prisma.session.findMany({
    where: { serverId: server.id, devPort: { not: null }, id: { not: sessionId } },
    select: { devPort: true },
  });
  const reserved = new Set(taken.map((s) => s.devPort).filter((p): p is number => p !== null));

  let listening: Set<number>;
  try {
    listening = await portsInUse(server);
  } catch {
    // If the host cannot be asked, fall back to the database's view alone.
    listening = new Set();
  }

  for (let port = RANGE_START; port <= RANGE_END; port += 1) {
    if (reserved.has(port) || listening.has(port)) continue;
    await prisma.session.update({ where: { id: sessionId }, data: { devPort: port } });
    return port;
  }
  return null;
}
