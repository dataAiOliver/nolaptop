import type { Resource, ResourceAllocation, Server, Session } from "@prisma/client";
import { prisma } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import { writeProjectFile } from "../remote/ops";
import { logEvent } from "../sessions";
import { allocatePostgres, dropPostgres, probePostgres } from "./postgres";
import { allocateS3, dropS3Bucket, probeS3 } from "./s3";

/**
 * Shared backing services, sliced per project.
 *
 * A project picks one Postgres and/or one S3 resource; this module reserves its
 * namespace, records the credentials, and — the part that actually saves time —
 * drops a `.env` into the project directory so Claude Code on that server knows
 * its own database and bucket without being told.
 */

export const RESOURCE_KINDS = ["POSTGRES", "S3"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type ResourceMeta = Record<string, string | number | boolean | null>;

/** What the client may see about a resource: no admin credentials, ever. */
export type PublicResource = {
  id: string;
  name: string;
  kind: ResourceKind;
  description: string | null;
  active: boolean;
  isDefault: boolean;
  status: string;
  statusMessage: string | null;
  lastCheckAt: string | null;
  /** A short, non-secret summary such as `db.internal:5432` or the endpoint. */
  target: string;
  layout: string | null;
  bucket: string | null;
  allocationCount?: number;
};

export function toPublicResource(resource: Resource, allocationCount?: number): PublicResource {
  const target =
    resource.kind === "POSTGRES"
      ? `${resource.host ?? "?"}:${resource.port ?? 5432}`
      : (resource.endpoint ?? "?");
  return {
    id: resource.id,
    name: resource.name,
    kind: resource.kind as ResourceKind,
    description: resource.description,
    active: resource.active,
    isDefault: resource.isDefault,
    status: resource.status,
    statusMessage: resource.statusMessage,
    lastCheckAt: resource.lastCheckAt?.toISOString() ?? null,
    target,
    layout: resource.layout,
    bucket: resource.bucket,
    allocationCount,
  };
}

// ------------------------------------------------------------------- probing

export type ResourceProbe = { ok: boolean; message: string };

export async function probeResource(resource: Resource): Promise<ResourceProbe> {
  const probe =
    resource.kind === "POSTGRES" ? await probePostgres(resource) : await probeS3(resource);

  await prisma.resource.update({
    where: { id: resource.id },
    data: {
      status: probe.ok ? "ONLINE" : "ERROR",
      statusMessage: probe.message.slice(0, 500),
      lastCheckAt: new Date(),
    },
  });

  return { ok: probe.ok, message: probe.message };
}

// ---------------------------------------------------------------- allocation

/**
 * Reserve this project's slice of a resource. Safe to call again: an existing
 * allocation is returned as-is rather than re-provisioned.
 */
export async function allocate(
  session: Session,
  resource: Resource,
): Promise<ResourceAllocation> {
  const existing = await prisma.resourceAllocation.findUnique({
    where: { sessionId_resourceId: { sessionId: session.id, resourceId: resource.id } },
  });
  if (existing && existing.state === "READY") return existing;

  try {
    if (resource.kind === "POSTGRES") {
      const result = await allocatePostgres(resource, session.projectName);
      const meta: ResourceMeta = {
        host: result.host,
        port: result.port,
        database: result.database,
      };
      return await upsertAllocation(session.id, resource.id, {
        namespace: result.database,
        username: result.username,
        secret: encryptSecret(result.url),
        metaJson: JSON.stringify(meta),
        state: "READY",
        error: null,
      });
    }

    const result = await allocateS3(resource, session.projectName);
    const meta: ResourceMeta = {
      endpoint: result.endpoint,
      region: result.region,
      bucket: result.bucket,
      prefix: result.prefix,
      forcePathStyle: result.forcePathStyle,
      accessKey: result.accessKey,
      /** Whether the key is scoped to this project, or shared with the resource. */
      dedicatedKey: false,
    };
    return await upsertAllocation(session.id, resource.id, {
      namespace: result.prefix ? `${result.bucket}/${result.prefix}` : result.bucket,
      username: result.accessKey,
      secret: encryptSecret(result.secretKey),
      metaJson: JSON.stringify(meta),
      state: "READY",
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return upsertAllocation(session.id, resource.id, {
      namespace: "",
      username: null,
      secret: null,
      metaJson: null,
      state: "ERROR",
      error: message.slice(0, 500),
    });
  }
}

async function upsertAllocation(
  sessionId: string,
  resourceId: string,
  data: {
    namespace: string;
    username: string | null;
    secret: string | null;
    metaJson: string | null;
    state: string;
    error: string | null;
  },
): Promise<ResourceAllocation> {
  return prisma.resourceAllocation.upsert({
    where: { sessionId_resourceId: { sessionId, resourceId } },
    create: { sessionId, resourceId, ...data },
    update: data,
  });
}

/**
 * Detach a resource from a project.
 *
 * `destroy` is off by default and has to be asked for: dropping a database is
 * exactly the kind of irreversible act this app does not do on its own.
 */
export async function deallocate(
  allocationId: string,
  opts: { destroy: boolean },
): Promise<{ destroyed: boolean; note: string }> {
  const allocation = await prisma.resourceAllocation.findUnique({
    where: { id: allocationId },
    include: { resource: true },
  });
  if (!allocation) return { destroyed: false, note: "Nothing to detach." };

  let destroyed = false;
  let note = "Detached. The data was left untouched.";

  if (opts.destroy && allocation.state === "READY") {
    if (allocation.resource.kind === "POSTGRES") {
      await dropPostgres(allocation.resource, allocation.namespace, allocation.username);
      destroyed = true;
      note = `Database ${allocation.namespace} and its role were dropped.`;
    } else {
      const bucket = allocation.namespace.split("/")[0];
      await dropS3Bucket(allocation.resource, bucket);
      destroyed = true;
      note = `Bucket ${bucket} was deleted.`;
    }
  }

  await prisma.resourceAllocation.delete({ where: { id: allocationId } });
  return { destroyed, note };
}

// ------------------------------------------------------------- env rendering

export type AllocationView = {
  id: string;
  resourceId: string;
  resourceName: string;
  kind: ResourceKind;
  namespace: string;
  state: string;
  error: string | null;
  /** Non-secret connection facts, safe to render. */
  meta: ResourceMeta;
  /** Present only when the caller explicitly asked to reveal secrets. */
  secret?: string | null;
  username?: string | null;
};

export function toAllocationView(
  allocation: ResourceAllocation & { resource: Resource },
  opts: { reveal?: boolean } = {},
): AllocationView {
  let meta: ResourceMeta = {};
  try {
    meta = allocation.metaJson ? (JSON.parse(allocation.metaJson) as ResourceMeta) : {};
  } catch {
    meta = {};
  }
  // The access key is an identifier, not the secret — but keep it out of the
  // default view anyway so a screenshot of the dashboard stays harmless.
  if (!opts.reveal) delete meta.accessKey;

  return {
    id: allocation.id,
    resourceId: allocation.resourceId,
    resourceName: allocation.resource.name,
    kind: allocation.resource.kind as ResourceKind,
    namespace: allocation.namespace,
    state: allocation.state,
    error: allocation.error,
    meta,
    ...(opts.reveal
      ? {
          username: allocation.username,
          secret: allocation.secret ? decryptSecret(allocation.secret) : null,
        }
      : {}),
  };
}

/** The environment variables one allocation contributes to a project's .env. */
export function envFor(allocation: ResourceAllocation & { resource: Resource }): Record<string, string> {
  if (allocation.state !== "READY" || !allocation.secret) return {};
  const secret = decryptSecret(allocation.secret);
  let meta: ResourceMeta = {};
  try {
    meta = allocation.metaJson ? (JSON.parse(allocation.metaJson) as ResourceMeta) : {};
  } catch {
    meta = {};
  }

  if (allocation.resource.kind === "POSTGRES") {
    return {
      DATABASE_URL: secret,
      PGHOST: String(meta.host ?? ""),
      PGPORT: String(meta.port ?? ""),
      PGDATABASE: String(meta.database ?? ""),
      PGUSER: allocation.username ?? "",
    };
  }

  const env: Record<string, string> = {
    S3_ENDPOINT: String(meta.endpoint ?? ""),
    S3_REGION: String(meta.region ?? ""),
    S3_BUCKET: String(meta.bucket ?? ""),
    S3_ACCESS_KEY_ID: allocation.username ?? "",
    S3_SECRET_ACCESS_KEY: secret,
    S3_FORCE_PATH_STYLE: String(meta.forcePathStyle ?? true),
    // The same values under the names the AWS SDK picks up by itself.
    AWS_ACCESS_KEY_ID: allocation.username ?? "",
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_REGION: String(meta.region ?? ""),
    AWS_ENDPOINT_URL_S3: String(meta.endpoint ?? ""),
  };
  if (meta.prefix) env.S3_PREFIX = String(meta.prefix);
  return env;
}

const ENV_HEADER = [
  "# Written by NoLaptop.",
  "# These credentials belong to this project's slice of a shared service.",
  "# Regenerated whenever the project's resources change — local edits below",
  "# the marker are preserved.",
];

const KEEP_MARKER = "# --- your own variables below this line ---";

function quoteEnv(value: string): string {
  // Always quote: a password may legitimately contain #, spaces or $.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

export function renderEnv(
  allocations: (ResourceAllocation & { resource: Resource })[],
  preserved: string,
  devPort?: number | null,
): string {
  const lines = [...ENV_HEADER, ""];
  if (devPort) {
    lines.push("# Port reserved for this project on this host.", `PORT=${devPort}`, "");
  }
  for (const allocation of allocations) {
    const env = envFor(allocation);
    if (Object.keys(env).length === 0) continue;
    lines.push(`# ${allocation.resource.name} (${allocation.resource.kind}) — ${allocation.namespace}`);
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${key}=${quoteEnv(value)}`);
    }
    lines.push("");
  }
  lines.push(KEEP_MARKER, preserved.trim(), "");
  return lines.join("\n");
}

/**
 * Push the project's resource configuration onto the server.
 *
 * Anything the user added to `.env` below the marker is read back and kept, so
 * regenerating never eats hand-written variables.
 */
export async function syncProjectFiles(
  server: Server,
  session: Session,
): Promise<{ wrote: boolean; note: string; shadowWarning: string | null }> {
  const allocations = await prisma.resourceAllocation.findMany({
    where: { sessionId: session.id },
    include: { resource: true },
    orderBy: { createdAt: "asc" },
  });

  let preserved = "";
  try {
    const { readProjectFile } = await import("../remote/ops");
    const current = await readProjectFile(server, session.projectPath, ".env");
    if (current) {
      const index = current.indexOf(KEEP_MARKER);
      preserved = index >= 0 ? current.slice(index + KEEP_MARKER.length) : "";
    }
  } catch {
    preserved = "";
  }

  await writeProjectFile(
    server,
    session.projectPath,
    ".env",
    renderEnv(allocations, preserved, session.devPort),
  );

  const { syncInstructions } = await import("../instructions");
  const instructions = await syncInstructions(server, session);

  return {
    wrote: true,
    note: `.env and ${instructions.fileName} updated in ${session.projectPath}.`,
    shadowWarning: instructions.shadowWarning,
  };
}

/** Attach the requested resources to a session and push the files. */
export async function attachResources(
  server: Server,
  session: Session,
  resourceIds: string[],
): Promise<AllocationView[]> {
  const resources = await prisma.resource.findMany({
    where: { id: { in: resourceIds }, active: true },
  });

  for (const resource of resources) {
    const allocation = await allocate(session, resource);
    if (allocation.state === "ERROR") {
      await logEvent(
        session.id,
        "error",
        `Could not reserve ${resource.name}: ${allocation.error ?? "unknown error"}`,
      );
    } else {
      await logEvent(
        session.id,
        "action",
        `Reserved ${allocation.namespace} on ${resource.name}.`,
      );
    }
  }

  if (resources.length > 0) {
    try {
      await syncProjectFiles(server, session);
    } catch (err) {
      await logEvent(
        session.id,
        "error",
        `Could not write the project files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const all = await prisma.resourceAllocation.findMany({
    where: { sessionId: session.id },
    include: { resource: true },
    orderBy: { createdAt: "asc" },
  });
  return all.map((a) => toAllocationView(a));
}
