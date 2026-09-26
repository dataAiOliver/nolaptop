import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  DEFAULT_PORTS,
  inspectStack,
  provisionStack,
  waitForStack,
  type StackKind,
} from "@/lib/remote/stack";
import { probeResource, toPublicResource } from "@/lib/resources";
import { serversChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** What the shared services look like on this host right now. */
export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return badRequest("Unknown server.");

    const [postgres, s3, resources] = await Promise.all([
      inspectStack(server, "POSTGRES"),
      inspectStack(server, "S3"),
      prisma.resource.findMany({ where: { serverId: id, managed: true } }),
    ]);

    return ok({
      stack: { POSTGRES: postgres, S3: s3 },
      resources: resources.map((r) => toPublicResource(r)),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const schema = z.object({ kind: z.enum(["POSTGRES", "S3"]) });

/**
 * Start a shared service on this host and register it as a resource.
 *
 * The container binds to the server's localhost; NoLaptop reaches it through
 * the SSH tunnel it already has. Nothing is published to the network.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return badRequest("Unknown server.");

    const { kind } = schema.parse(await request.json()) as { kind: StackKind };

    const existingResource = await prisma.resource.findFirst({
      where: { serverId: id, managed: true, kind },
    });
    if (existingResource) {
      // Already registered. Make sure the container is up, reusing the stored
      // admin password so a container that was removed comes back with the
      // credentials this app already handed out.
      const storedSecret =
        kind === "POSTGRES" ? existingResource.adminPassword : existingResource.secretKey;
      if (!storedSecret) {
        return badRequest(
          `"${existingResource.name}" is registered but has no stored credentials. Remove it under Data and start the service again.`,
        );
      }
      await provisionStack(server, kind, {
        password: decryptSecret(storedSecret),
        username: (kind === "POSTGRES" ? existingResource.adminUser : existingResource.accessKey) ?? undefined,
        port: existingResource.remotePort ?? DEFAULT_PORTS[kind],
      });
      await probeResource(existingResource);
      const fresh = await prisma.resource.findUnique({ where: { id: existingResource.id } });
      return ok({ resource: fresh ? toPublicResource(fresh) : null, created: false });
    }

    const password = crypto.randomBytes(24).toString("base64url");
    const username = kind === "POSTGRES" ? "postgres" : "nolaptop";
    const port = DEFAULT_PORTS[kind];

    const result = await provisionStack(server, kind, { password, username, port });
    await waitForStack(server, kind, result.port);

    const resource = await prisma.resource.create({
      data: {
        name: `${server.name} ${kind === "POSTGRES" ? "Postgres" : "Storage"}`,
        kind,
        description: `Started by NoLaptop on ${server.name}, reachable over SSH only.`,
        active: true,
        isDefault: true,
        serverId: server.id,
        managed: true,
        remotePort: result.port,
        ...(kind === "POSTGRES"
          ? {
              host: "127.0.0.1",
              port: result.port,
              adminUser: result.username,
              adminPassword: encryptSecret(result.password),
              adminDatabase: "postgres",
              sslMode: "disable",
            }
          : {
              endpoint: `http://127.0.0.1:${result.port}`,
              region: "us-east-1",
              accessKey: result.username,
              secretKey: encryptSecret(result.password),
              layout: "PER_PROJECT_BUCKET",
              forcePathStyle: true,
            }),
      },
    });

    // One default per kind keeps the New Project screen unambiguous.
    await prisma.resource.updateMany({
      where: { kind, id: { not: resource.id } },
      data: { isDefault: false },
    });

    await probeResource(resource);
    serversChanged();

    const fresh = await prisma.resource.findUnique({ where: { id: resource.id } });
    return ok({ resource: fresh ? toPublicResource(fresh) : null, created: result.created });
  } catch (err) {
    if (err instanceof z.ZodError) return badRequest("Unknown service.");
    return errorResponse(err);
  }
}
