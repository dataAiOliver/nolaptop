import type { Server } from "@prisma/client";
import { sshExec } from "../ssh";
import { sq } from "../shell";

/**
 * Bringing the shared services up on a server, in one click.
 *
 * This is the part that makes "a configured environment, not just a session"
 * true: instead of asking you to install Postgres somewhere first, NoLaptop can
 * start it on the server itself, as two well-known containers.
 *
 * Both are bound to the server's **localhost** — never a public interface — and
 * reached through an SSH tunnel. A database with a generated password on a
 * public VPS port is exactly the kind of thing that ends up in a breach report.
 *
 * Like everything else here, this is a closed set of operations: fixed images,
 * fixed container names, fixed arguments. There is no path from the API to an
 * arbitrary `docker run`.
 */

export const STACK_CONTAINERS = {
  POSTGRES: "nolaptop-postgres",
  S3: "nolaptop-seaweedfs",
} as const;

export type StackKind = keyof typeof STACK_CONTAINERS;

/**
 * Images, overridable per installation.
 *
 * The object store is SeaweedFS, not MinIO. Two reasons, in order of weight:
 * SeaweedFS is Apache-2.0 and stays that way, while MinIO moved its community
 * edition behind AGPL and then closed anonymous pulls of `minio/minio`
 * entirely — a default that fails on a fresh host is not a default. SeaweedFS
 * speaks the same S3 API surface this app uses (ListBuckets, HeadBucket,
 * CreateBucket, PutObject) with SigV4.
 */
const IMAGES: Record<StackKind, string> = {
  POSTGRES: process.env.NL_POSTGRES_IMAGE || "postgres:18-alpine",
  S3: process.env.NL_S3_IMAGE || "chrislusf/seaweedfs:4.46",
};

const VOLUMES: Record<StackKind, string> = {
  POSTGRES: "nolaptop-pgdata",
  S3: "nolaptop-s3data",
};

/** 5433 sits clear of a local Postgres; 8333 is SeaweedFS's own S3 default. */
export const DEFAULT_PORTS: Record<StackKind, number> = {
  POSTGRES: 5433,
  S3: 8333,
};

/** Where the SeaweedFS identity file lives on the server. */
const S3_CONFIG_DIR = "$HOME/.nolaptop";
const S3_CONFIG_FILE = "$HOME/.nolaptop/seaweedfs-s3.json";

const ENV_PREFIX = `export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"; `;

function run(server: Server, script: string, timeoutMs = 30_000) {
  return sshExec(server, ENV_PREFIX + script, { timeoutMs });
}

export type StackStatus = {
  kind: StackKind;
  dockerAvailable: boolean;
  /** The container exists, whether or not it is running. */
  exists: boolean;
  running: boolean;
  /** Host port the container publishes on the server's loopback. */
  port: number | null;
  image: string | null;
  /** Human-readable detail for the UI. */
  detail: string | null;
};

export async function inspectStack(server: Server, kind: StackKind): Promise<StackStatus> {
  const name = STACK_CONTAINERS[kind];
  const res = await run(
    server,
    [
      `echo "###DOCKER"; command -v docker >/dev/null 2>&1 && echo yes || echo no`,
      `echo "###STATE"; docker inspect -f '{{.State.Running}}' ${sq(name)} 2>/dev/null || echo missing`,
      `echo "###IMAGE"; docker inspect -f '{{.Config.Image}}' ${sq(name)} 2>/dev/null || echo ""`,
      `echo "###PORT"; docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}}{{end}}{{end}}' ${sq(name)} 2>/dev/null || echo ""`,
    ].join("; "),
  );

  const sections = splitSections(res.stdout);
  const dockerAvailable = sections.DOCKER?.trim() === "yes";
  const state = sections.STATE?.trim() ?? "missing";
  const exists = state !== "missing" && state !== "";
  const running = state === "true";
  const portRaw = (sections.PORT ?? "").trim().split(/\s+/)[0];
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : null;

  return {
    kind,
    dockerAvailable,
    exists,
    running,
    port,
    image: sections.IMAGE?.trim() || null,
    detail: !dockerAvailable
      ? "Docker was not found on this host."
      : !exists
        ? null
        : running
          ? null
          : "The container exists but is stopped.",
  };
}

export type ProvisionResult = {
  kind: StackKind;
  port: number;
  /** Credentials generated for the admin account. */
  username: string;
  password: string;
  created: boolean;
};

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Refusing to publish on port ${port}.`);
  }
}

/**
 * Start the container if it is not there yet.
 *
 * If it already exists, nothing is recreated — the caller keeps whatever
 * credentials it stored. Re-provisioning a live database would be a fine way to
 * lose access to it.
 */
export async function provisionStack(
  server: Server,
  kind: StackKind,
  options: { port?: number; username?: string; password: string },
): Promise<ProvisionResult> {
  const name = STACK_CONTAINERS[kind];
  const port = options.port ?? DEFAULT_PORTS[kind];
  assertPort(port);

  const existing = await inspectStack(server, kind);
  if (!existing.dockerAvailable) {
    throw new Error("Docker is not installed on this host, so the shared services cannot be started here.");
  }
  if (existing.exists) {
    if (!existing.running) {
      const started = await run(server, `docker start ${sq(name)} 2>&1`);
      if (started.code !== 0) {
        throw new Error(`Could not start ${name}: ${started.stdout.trim() || started.stderr.trim()}`);
      }
    }
    return {
      kind,
      port: existing.port ?? port,
      username: options.username ?? (kind === "POSTGRES" ? "postgres" : "nolaptop"),
      password: options.password,
      created: false,
    };
  }

  const bind = `127.0.0.1:${port}`;
  const volume = VOLUMES[kind];
  const image = IMAGES[kind];

  const script =
    kind === "POSTGRES"
      ? [
          `docker volume create ${sq(volume)} >/dev/null`,
          // Postgres 18 wants the mount one level above the data directory.
          `docker run -d --name ${sq(name)} --restart unless-stopped ` +
            `-e POSTGRES_PASSWORD=${sq(options.password)} ` +
            `-v ${sq(`${volume}:/var/lib/postgresql`)} ` +
            `-p ${sq(`${bind}:5432`)} ${sq(image)} 2>&1`,
        ].join(" && ")
      : [
          // SeaweedFS takes its S3 credentials from an identity file rather
          // than environment variables, so it is written first, readable only
          // by this user, and mounted read-only.
          `mkdir -p ${S3_CONFIG_DIR} && chmod 700 ${S3_CONFIG_DIR}`,
          `printf '%s' ${sq(seaweedIdentityJson(options.username ?? "nolaptop", options.password))} > ${S3_CONFIG_FILE}`,
          `chmod 600 ${S3_CONFIG_FILE}`,
          `docker volume create ${sq(volume)} >/dev/null`,
          `docker run -d --name ${sq(name)} --restart unless-stopped ` +
            `-v ${sq(`${volume}:/data`)} ` +
            `-v "$HOME/.nolaptop/seaweedfs-s3.json:/etc/seaweedfs/s3.json:ro" ` +
            `-p ${sq(`${bind}:8333`)} ${sq(image)} ` +
            `server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json 2>&1`,
        ].join(" && ");

  const res = await run(server, script, 180_000);
  if (res.code !== 0) {
    const output = (res.stdout + res.stderr).trim().slice(-400);
    throw new Error(`Could not start ${name}: ${output}`);
  }

  return {
    kind,
    port,
    username: options.username ?? (kind === "POSTGRES" ? "postgres" : "nolaptop"),
    password: options.password,
    created: true,
  };
}

/** Stop the container. Data in its volume is kept. */
export async function stopStack(server: Server, kind: StackKind): Promise<void> {
  await run(server, `docker stop ${sq(STACK_CONTAINERS[kind])} 2>/dev/null || true`, 60_000);
}

/** Wait until the service answers, so the caller does not probe too early. */
export async function waitForStack(server: Server, kind: StackKind, port: number): Promise<boolean> {
  const check =
    kind === "POSTGRES"
      ? `docker exec ${sq(STACK_CONTAINERS.POSTGRES)} pg_isready -q`
      // SeaweedFS answers 403 on an unsigned request once S3 auth is up, which
      // is exactly the signal that it is ready to serve.
      : `test "$(curl -s -o /dev/null -w '%{http_code}' ${sq(`http://127.0.0.1:${port}/`)})" != "000"`;

  const res = await run(
    server,
    `for i in $(seq 1 30); do if ${check} 2>/dev/null; then echo ready; exit 0; fi; sleep 2; done; echo timeout`,
    90_000,
  );
  return res.stdout.includes("ready");
}

/** SeaweedFS identity file granting one admin account full S3 access. */
function seaweedIdentityJson(accessKey: string, secretKey: string): string {
  return JSON.stringify({
    identities: [
      {
        name: accessKey,
        credentials: [{ accessKey, secretKey }],
        actions: ["Admin", "Read", "Write", "List", "Tagging"],
      },
    ],
  });
}

function splitSections(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of out.split("\n")) {
    const match = /^###([A-Z]+)\s*$/.exec(line);
    if (match) {
      if (current) result[current] = buffer.join("\n");
      current = match[1];
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) result[current] = buffer.join("\n");
  return result;
}
