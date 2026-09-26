import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptSecret, encryptionKeyConfigured } from "@/lib/crypto";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeResource, toPublicResource } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAuth();
    const resources = await prisma.resource.findMany({
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      include: { _count: { select: { allocations: true } } },
    });
    return ok({ resources: resources.map((r) => toPublicResource(r, r._count.allocations)) });
  } catch (err) {
    return errorResponse(err);
  }
}

const baseSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const postgresSchema = baseSchema.extend({
  kind: z.literal("POSTGRES"),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  adminUser: z.string().trim().min(1),
  adminPassword: z.string().min(1),
  adminDatabase: z.string().trim().min(1).default("postgres"),
  sslMode: z.enum(["disable", "prefer", "require", "no-verify"]).default("prefer"),
});

const s3Schema = baseSchema.extend({
  kind: z.literal("S3"),
  endpoint: z.string().trim().url(),
  region: z.string().trim().min(1).default("us-east-1"),
  accessKey: z.string().trim().min(1),
  secretKey: z.string().min(1),
  layout: z.enum(["PER_PROJECT_BUCKET", "SHARED_BUCKET_PREFIX"]).default("PER_PROJECT_BUCKET"),
  bucket: z.string().trim().optional().nullable(),
  forcePathStyle: z.boolean().default(true),
});

const createSchema = z.discriminatedUnion("kind", [postgresSchema, s3Schema]);

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    if (!encryptionKeyConfigured()) {
      return badRequest("NL_ENCRYPTION_KEY is not set, so credentials cannot be stored safely.");
    }
    const body = createSchema.parse(await request.json());

    if (body.kind === "S3" && body.layout === "SHARED_BUCKET_PREFIX" && !body.bucket?.trim()) {
      return badRequest("A shared-bucket resource needs the name of that bucket.");
    }

    const data =
      body.kind === "POSTGRES"
        ? {
            kind: "POSTGRES",
            host: body.host,
            port: body.port,
            adminUser: body.adminUser,
            adminPassword: encryptSecret(body.adminPassword),
            adminDatabase: body.adminDatabase,
            sslMode: body.sslMode,
          }
        : {
            kind: "S3",
            endpoint: body.endpoint.replace(/\/+$/, ""),
            region: body.region,
            accessKey: body.accessKey,
            secretKey: encryptSecret(body.secretKey),
            layout: body.layout,
            bucket: body.bucket?.trim() || null,
            forcePathStyle: body.forcePathStyle,
          };

    const resource = await prisma.resource.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        active: body.active,
        isDefault: body.isDefault,
        ...data,
      },
    });

    // Only one default per kind, so the New Project screen stays unambiguous.
    if (resource.isDefault) {
      await prisma.resource.updateMany({
        where: { kind: resource.kind, id: { not: resource.id } },
        data: { isDefault: false },
      });
    }

    void probeResource(resource);
    return ok({ resource: toPublicResource(resource, 0) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return badRequest("A resource with that name already exists.");
    }
    return errorResponse(err);
  }
}
