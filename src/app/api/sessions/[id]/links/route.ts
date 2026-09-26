import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { sessionChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const createSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    port: z.coerce.number().int().min(1).max(65535).optional().nullable(),
    url: z.string().trim().max(500).optional().nullable(),
    note: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => Boolean(v.port) || Boolean(v.url), {
    message: "Give it a port on the server, or a URL.",
  });

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const links = await prisma.sessionLink.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    });
    return ok({ links });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return badRequest("Unknown session.");

    const body = createSchema.parse(await request.json());
    if (body.url && !/^https?:\/\//i.test(body.url)) {
      return badRequest("A URL has to start with http:// or https://.");
    }
    const count = await prisma.sessionLink.count({ where: { sessionId: id } });
    if (count >= 20) return badRequest("A project can hold at most 20 links.");

    const link = await prisma.sessionLink.create({
      data: {
        sessionId: id,
        label: body.label,
        port: body.port ?? null,
        url: body.url || null,
        note: body.note || null,
      },
    });
    sessionChanged(id);
    return ok({ link });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => i.message).join(", "));
    }
    return errorResponse(err);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const linkId = request.nextUrl.searchParams.get("linkId");
    if (!linkId) return badRequest("Which link should be removed?");

    const link = await prisma.sessionLink.findUnique({ where: { id: linkId } });
    if (!link || link.sessionId !== id) return badRequest("That link is not part of this project.");

    await prisma.sessionLink.delete({ where: { id: linkId } });
    sessionChanged(id);
    return ok({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
