import type { Resource } from "@prisma/client";
import { prisma } from "../db";
import { tunnelTo } from "../tunnel";

/**
 * Where to actually dial a resource.
 *
 * A resource NoLaptop started itself is bound to its server's localhost, so it
 * is reached through that server's SSH tunnel. One that you pointed at by hand
 * is dialled directly. Callers never decide this — they ask here.
 */

export type Endpoint = { host: string; port: number };

export async function resolveEndpoint(resource: Resource, fallbackPort: number): Promise<Endpoint> {
  const directHost = resource.host ?? "";
  const directPort = resource.port ?? fallbackPort;

  if (!resource.serverId) {
    if (!directHost) throw new Error(`Resource "${resource.name}" has no host configured.`);
    return { host: directHost, port: directPort };
  }

  const server = await prisma.server.findUnique({ where: { id: resource.serverId } });
  if (!server) {
    throw new Error(`Resource "${resource.name}" points at a server that no longer exists.`);
  }

  const remotePort = resource.remotePort ?? directPort;
  const localPort = await tunnelTo(server, remotePort);
  return { host: "127.0.0.1", port: localPort };
}

/** The S3 base URL to sign and send against, tunnelled when necessary. */
export async function resolveS3BaseUrl(resource: Resource): Promise<string> {
  const configured = (resource.endpoint ?? "").replace(/\/+$/, "");
  if (!resource.serverId) {
    if (!configured) throw new Error(`Resource "${resource.name}" has no endpoint configured.`);
    return configured;
  }

  const server = await prisma.server.findUnique({ where: { id: resource.serverId } });
  if (!server) {
    throw new Error(`Resource "${resource.name}" points at a server that no longer exists.`);
  }

  const remotePort = resource.remotePort ?? (configured ? Number(new URL(configured).port) || 80 : 9000);
  const localPort = await tunnelTo(server, remotePort);
  return `http://127.0.0.1:${localPort}`;
}
