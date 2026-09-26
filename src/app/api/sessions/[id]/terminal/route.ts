import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { ClaudeAdapter } from "@/lib/claude/adapter";
import { detectInterrupt } from "@/lib/claude/interrupts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only window into the managed tmux pane. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({ where: { id }, include: { server: true } });
    if (!session) return badRequest("Unknown session.");

    const linesParam = Number(request.nextUrl.searchParams.get("lines") ?? 120);
    const pane = await ClaudeAdapter.captureTerminal(
      session.server,
      session,
      Number.isFinite(linesParam) ? linesParam : 120,
    );

    return ok({ terminal: pane, interrupt: detectInterrupt(pane) });
  } catch (err) {
    return errorResponse(err);
  }
}
