import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { attachResources, deallocate, syncProjectFiles, toAllocationView } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function loadSession(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: { server: true, allocations: { include: { resource: true }, orderBy: { createdAt: "asc" } } },
  });
}

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await loadSession(id);
    if (!session) return badRequest("Unknown session.");

    // Secrets are only sent when the user explicitly asks to see them.
    const reveal = request.nextUrl.searchParams.get("reveal") === "1";
    return ok({ allocations: session.allocations.map((a) => toAllocationView(a, { reveal })) });
  } catch (err) {
    return errorResponse(err);
  }
}

const attachSchema = z.object({ resourceIds: z.array(z.string().min(1)).max(8) });

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await loadSession(id);
    if (!session) return badRequest("Unknown session.");

    const { resourceIds } = attachSchema.parse(await request.json());
    const allocations = await attachResources(session.server, session, resourceIds);
    return ok({ allocations });
  } catch (err) {
    if (err instanceof z.ZodError) return badRequest("Invalid resource selection.");
    return errorResponse(err);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const allocationId = request.nextUrl.searchParams.get("allocationId");
    if (!allocationId) return badRequest("Which allocation should be detached?");
    const destroy = request.nextUrl.searchParams.get("destroy") === "1";

    const session = await loadSession(id);
    if (!session) return badRequest("Unknown session.");
    if (!session.allocations.some((a) => a.id === allocationId)) {
      return badRequest("That allocation does not belong to this session.");
    }

    const result = await deallocate(allocationId, { destroy });
    try {
      const fresh = await loadSession(id);
      if (fresh) await syncProjectFiles(fresh.server, fresh);
    } catch {
      // The .env refresh is best effort; the detach itself already happened.
    }
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
