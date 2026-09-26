import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeResource, toPublicResource } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const resource = await prisma.resource.findUnique({ where: { id } });
    if (!resource) return badRequest("Unknown resource.");

    const probe = await probeResource(resource);
    const updated = await prisma.resource.findUnique({ where: { id } });
    return ok({ probe, resource: updated ? toPublicResource(updated) : null });
  } catch (err) {
    return errorResponse(err);
  }
}
