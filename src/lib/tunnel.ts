import net from "node:net";
import type { Duplex } from "node:stream";
import { getSshClient, type SshTarget } from "./ssh";

/**
 * Local port forwarding over the existing SSH connection.
 *
 * Services NoLaptop provisions on a server are bound to that server's
 * localhost — never to a public interface. That is the right default for a
 * database with a generated password sitting on a VPS, but it means the app
 * cannot simply dial them.
 *
 * So it dials through SSH: a local TCP listener pipes each connection into a
 * `direct-tcpip` channel on the server. Anything that speaks TCP — the Postgres
 * driver, `fetch` against the S3 endpoint — then works unchanged against
 * 127.0.0.1:<local port>, with nothing exposed on the server.
 */

type Tunnel = {
  localPort: number;
  server: net.Server;
  lastUsed: number;
};

const globalForTunnels = globalThis as unknown as { nlTunnels?: Map<string, Promise<Tunnel>> };
const tunnels: Map<string, Promise<Tunnel>> = (globalForTunnels.nlTunnels ??= new Map());

const IDLE_MS = 10 * 60_000;

function key(serverId: string, remotePort: number): string {
  return `${serverId}:${remotePort}`;
}

async function createTunnel(target: SshTarget, remotePort: number): Promise<Tunnel> {
  const client = await getSshClient(target);

  const server = net.createServer((socket) => {
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, channel?: Duplex) => {
      if (err || !channel) {
        socket.destroy();
        return;
      }
      socket.pipe(channel).pipe(socket);
      const close = () => {
        socket.destroy();
        channel.destroy?.();
      };
      socket.on("error", close);
      channel.on("error", close);
    });
  });

  // Port 0 lets the OS pick a free one, so two tunnels never collide.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    server.close();
    throw new Error("Could not open a local port for the SSH tunnel.");
  }

  server.unref();
  return { localPort: address.port, server, lastUsed: Date.now() };
}

/**
 * Get (or open) a tunnel to `remotePort` on the server, and return the local
 * port to connect to instead.
 */
export async function tunnelTo(target: SshTarget, remotePort: number): Promise<number> {
  const id = key(target.id, remotePort);
  const existing = tunnels.get(id);
  if (existing) {
    try {
      const tunnel = await existing;
      if (tunnel.server.listening) {
        tunnel.lastUsed = Date.now();
        return tunnel.localPort;
      }
    } catch {
      // fall through and rebuild
    }
    tunnels.delete(id);
  }

  const created = createTunnel(target, remotePort);
  tunnels.set(id, created);
  try {
    return (await created).localPort;
  } catch (err) {
    tunnels.delete(id);
    throw err;
  }
}

export function closeTunnels(serverId: string): void {
  for (const [id, promise] of tunnels.entries()) {
    if (!id.startsWith(`${serverId}:`)) continue;
    tunnels.delete(id);
    promise.then((tunnel) => tunnel.server.close()).catch(() => undefined);
  }
}

export function reapIdleTunnels(): void {
  const now = Date.now();
  for (const [id, promise] of tunnels.entries()) {
    promise
      .then((tunnel) => {
        if (now - tunnel.lastUsed > IDLE_MS) {
          tunnels.delete(id);
          tunnel.server.close();
        }
      })
      .catch(() => tunnels.delete(id));
  }
}
