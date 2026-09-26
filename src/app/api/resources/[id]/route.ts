import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { toPublicResource } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  host: z.string().trim().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  adminUser: z.string().trim().min(1).optional(),
  adminPassword: z.string().min(1).optional(),
  adminDatabase: z.string().trim().min(1).optional(),
  sslMode: z.enum(["disable", "prefer", "require", "no-verify"]).optional(),
  endpoint: z.string().trim().url().optional(),
  region: z.string().trim().min(1).optional(),
  accessKey: z.string().trim().min(1).optional(),
  secretKey: z.string().min(1).optional(),
  layout: z.enum(["PER_PROJECT_BUCKET", "SHARED_BUCKET_PREFIX"]).optional(),
  bucket: z.string().trim().optional().nullable(),
  forcePathStyle: z.boolean().optional(),
});

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const resource = await prisma.resource.findUnique({
      where: { id },
      include: { _count: { select: { allocations: true } } },
    });
    if (!resource) return badRequest("Unknown resource.");
    return ok({ resource: toPublicResource(resource, resource._count.allocations) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const body = patchSchema.parse(await request.json());

    const data: Record<string, unknown> = {};
    for (const field of [
      "name", "description", "active", "isDefault", "host", "port", "adminUser",
      "adminDatabase", "sslMode", "region", "accessKey", "layout", "bucket", "forcePathStyle",
    ] as const) {
      if (body[field] !== undefined) data[field] = body[field];
    }
    if (body.endpoint) data.endpoint = body.endpoint.replace(/\/+$/, "");
    if (body.adminPassword) data.adminPassword = encryptSecret(body.adminPassword);
    if (body.secretKey) data.secretKey = encryptSecret(body.secretKey);

    const resource = await prisma.resource.update({ where: { id }, data });
    if (resource.isDefault) {
      await prisma.resource.updateMany({
        where: { kind: resource.kind, id: { not: resource.id } },
        data: { isDefault: false },
      });
    }
    return ok({ resource: toPublicResource(resource) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    return errorResponse(err);
  }
}

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const resource = await prisma.resource.findUnique({
      where: { id },
      include: { _count: { select: { allocations: true } } },
    });
    if (!resource) return badRequest("Unknown resource.");

    // Removing the resource entry forgets the credentials. The databases and
    // buckets it provisioned stay where they are.
    await prisma.resource.delete({ where: { id } });
    return ok({
      deleted: true,
      note:
        resource._count.allocations > 0
          ? `${resource._count.allocations} project allocation(s) were forgotten. No database or bucket was deleted.`
          : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
