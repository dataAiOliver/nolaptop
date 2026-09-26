import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { syncInstructions } from "@/lib/instructions";
import { readProjectFile } from "@/lib/remote/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The instructions file as it currently is on the server. */
export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({ where: { id }, include: { server: true } });
    if (!session) return badRequest("Unknown session.");

    const fileName = session.server.agentsFileName || "AGENTS.md";
    const content = await readProjectFile(session.server, session.projectPath, fileName);
    return ok({ fileName, content });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Regenerate it, keeping anything written below the marker. */
export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({ where: { id }, include: { server: true } });
    if (!session) return badRequest("Unknown session.");

    const result = await syncInstructions(session.server, session);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
