import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { syncProjectFiles } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rewrite .env and RESOURCES.md in the project directory. */
export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({ where: { id }, include: { server: true } });
    if (!session) return badRequest("Unknown session.");

    const result = await syncProjectFiles(session.server, session);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
