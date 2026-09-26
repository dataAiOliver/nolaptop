import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { runAction, type SessionAction } from "@/lib/sessions";
import { toSessionDto } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["stop", "resume", "reconnect", "restart", "authenticate", "approve", "refresh"]),
});

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const { action } = schema.parse(await request.json());

    const result = await runAction(id, action as SessionAction);
    const session = await prisma.session.findUnique({ where: { id }, include: { server: true } });

    return ok({ result, session: session ? toSessionDto(session) : null });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest("Unknown action.");
    }
    return errorResponse(err);
  }
}
