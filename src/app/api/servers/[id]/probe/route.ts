import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeServer, toPublicServer } from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return badRequest("Unknown server.");

    const probe = await probeServer(server);
    const updated = await prisma.server.findUnique({ where: { id } });
    return ok({ probe, server: updated ? toPublicServer(updated) : null });
  } catch (err) {
    return errorResponse(err);
  }
}
