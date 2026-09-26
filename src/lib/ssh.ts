import crypto from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import type { Server } from "@prisma/client";
import { prisma } from "./db";
import { decryptSecret } from "./crypto";

export type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * What connecting actually needs. Narrower than `Server` so a caller can dial a
 * host that has not been saved yet, and so adding a column to Server never
 * breaks the callers. An empty `id` means "throwaway": nothing is pinned.
 */
export type SshTarget = Pick<
  Server,
  "id" | "host" | "port" | "username" | "privateKey" | "passphrase" | "hostKeyFingerprint"
>;

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind: "AUTH" | "NETWORK" | "TIMEOUT" | "EXEC" | "HOST_KEY" = "NETWORK",
  ) {
    super(message);
    this.name = "SshError";
  }
}

/** OpenSSH-style fingerprint, so it can be compared with `ssh-keygen -lf`. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const IDLE_EVICT_MS = 120_000;

type Pooled = { client: Client; lastUsed: number; closing: boolean };

const globalForSsh = globalThis as unknown as { nlSshPool?: Map<string, Promise<Pooled>> };
const pool: Map<string, Promise<Pooled>> = (globalForSsh.nlSshPool ??= new Map());

function poolKey(server: Pick<SshTarget, "id" | "host" | "port" | "username">): string {
  return `${server.id}:${server.username}@${server.host}:${server.port}`;
}

/**
 * Trust on first use: the first successful connection records the host key, and
 * every later one has to present the same key.
 *
 * Without this, ssh2 accepts any key — which would mean the commands this app
 * runs, and the service credentials it writes, could be handed to whoever
 * answers on that address. A legitimate rebuild of a server is handled by
 * clearing the stored fingerprint in the UI.
 */
function connectConfig(server: SshTarget, onSeenKey: (fp: string) => void): ConnectConfig {
  const pinned = server.hostKeyFingerprint;
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    privateKey: decryptSecret(server.privateKey),
    passphrase: server.passphrase ? decryptSecret(server.passphrase) : undefined,
    readyTimeout: DEFAULT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => {
      const fingerprint = hostKeyFingerprint(key);
      if (!pinned) {
        onSeenKey(fingerprint);
        return true;
      }
      const a = Buffer.from(fingerprint);
      const b = Buffer.from(pinned);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

function classify(err: Error): SshError {
  const msg = err.message || String(err);
  if (/host.?key|handshake failed|verification/i.test(msg)) {
    return new SshError(
      "The server presented a different SSH host key than the one recorded for it. " +
        "If the host was genuinely rebuilt, clear its stored fingerprint; otherwise stop and investigate.",
      "HOST_KEY",
    );
  }
  if (/authentication|publickey|privatekey|passphrase|permission denied/i.test(msg)) {
    return new SshError(`SSH authentication failed: ${msg}`, "AUTH");
  }
  if (/timed out|timeout/i.test(msg)) return new SshError(`SSH timed out: ${msg}`, "TIMEOUT");
  return new SshError(`SSH connection failed: ${msg}`, "NETWORK");
}

function openConnection(server: SshTarget): Promise<Pooled> {
  return new Promise<Pooled>((resolve, reject) => {
    const client = new Client();
    const entry: Pooled = { client, lastUsed: Date.now(), closing: false };

    const onError = (err: Error) => {
      entry.closing = true;
      pool.delete(poolKey(server));
      reject(classify(err));
    };

    client.once("ready", () => {
      client.removeListener("error", onError);
      client.on("error", () => {
        entry.closing = true;
        pool.delete(poolKey(server));
      });
      client.on("close", () => {
        entry.closing = true;
        pool.delete(poolKey(server));
      });
      resolve(entry);
    });
    client.once("error", onError);

    let config: ConnectConfig;
    let seenKey: string | null = null;
    try {
      config = connectConfig(server, (fp) => {
        seenKey = fp;
      });
    } catch (err) {
      reject(new SshError((err as Error).message, "AUTH"));
      return;
    }

    client.once("ready", () => {
      // Pin the key only once the connection actually authenticated.
      if (seenKey && !server.hostKeyFingerprint && server.id) {
        void prisma.server
          .update({ where: { id: server.id }, data: { hostKeyFingerprint: seenKey } })
          .catch(() => undefined);
      }
    });

    client.connect(config);
  });
}

async function getConnection(server: SshTarget): Promise<Pooled> {
  const key = poolKey(server);
  const existing = pool.get(key);
  if (existing) {
    try {
      const entry = await existing;
      if (!entry.closing) {
        entry.lastUsed = Date.now();
        return entry;
      }
    } catch {
      // fall through and reconnect
    }
    pool.delete(key);
  }
  const created = openConnection(server);
  pool.set(key, created);
  try {
    return await created;
  } catch (err) {
    pool.delete(key);
    throw err;
  }
}

/**
 * Run one command on a server. Callers never build this string from client
 * input directly — see lib/remote/ops.ts, which owns the whole command surface.
 */
export function sshExec(
  server: SshTarget,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    getConnection(server).then((entry) => {
      entry.lastUsed = Date.now();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SshError(`Command timed out after ${timeoutMs}ms`, "TIMEOUT"));
      }, timeoutMs);

      entry.client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new SshError(`Failed to start remote command: ${err.message}`, "EXEC"));
          }
          return;
        }
        let stdout = "";
        let stderr = "";
        let code = 0;
        stream.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        stream.on("exit", (exitCode: number | null) => {
          code = exitCode ?? 0;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({ code, stdout, stderr });
        });
      });
    }, reject);
  });
}

/**
 * The raw ssh2 client, for callers that need more than "run a command" —
 * currently only the tunnel layer, which opens direct-tcpip channels.
 */
export async function getSshClient(target: SshTarget): Promise<Client> {
  const entry = await getConnection(target);
  entry.lastUsed = Date.now();
  return entry.client;
}

/** Evict connections nobody has used for a while so idle servers drop off. */
export function reapIdleConnections(): void {
  const now = Date.now();
  for (const [key, promise] of pool.entries()) {
    promise
      .then((entry) => {
        if (now - entry.lastUsed > IDLE_EVICT_MS) {
          entry.closing = true;
          entry.client.end();
          pool.delete(key);
        }
      })
      .catch(() => pool.delete(key));
  }
}

export function dropConnection(serverId: string): void {
  for (const [key, promise] of pool.entries()) {
    if (!key.startsWith(`${serverId}:`)) continue;
    pool.delete(key);
    promise.then((entry) => entry.client.end()).catch(() => undefined);
  }
}
