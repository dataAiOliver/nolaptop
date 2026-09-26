import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { deleteSession, refreshSessionDetail } from "@/lib/sessions";
import { toSessionDto } from "@/lib/serialize";
import { detectInterrupt } from "@/lib/claude/interrupts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        server: true,
        allocations: { include: { resource: true }, orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "desc" }, take: 40 },
      },
    });
    if (!session) return badRequest("Unknown session.");

    const wantsLive = request.nextUrl.searchParams.get("live") !== "0";
    let pane: string | null = null;
    let usage = null;

    if (wantsLive && session.server.active) {
      try {
        const detail = await refreshSessionDetail(session.server, session);
        pane = detail.pane;
        usage = detail.usage;
      } catch {
        // Fall back to the stored snapshot below.
      }
    }

    const fresh = await prisma.session.findUnique({
      where: { id },
      include: {
        server: true,
        allocations: { include: { resource: true }, orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "desc" }, take: 40 },
      },
    });
    const current = fresh ?? session;

    return ok({
      session: toSessionDto(current),
      usage: usage ?? toSessionDto(current).usage,
      interrupt: pane ? detectInterrupt(pane) : null,
      terminal: pane,
      events: current.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const stopFirst = request.nextUrl.searchParams.get("stop") === "1";
    await deleteSession(id, { stopFirst });
    return ok({ deleted: true, stopped: stopFirst });
  } catch (err) {
    return errorResponse(err);
  }
}
