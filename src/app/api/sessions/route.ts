import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { createSession } from "@/lib/sessions";
import { toSessionDto } from "@/lib/serialize";
import { normalizeProjectName } from "@/lib/shell";
import { startMonitor } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAuth();
    startMonitor();
    const sessions = await prisma.session.findMany({
      include: {
        server: true,
        allocations: { include: { resource: true } },
        links: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
    return ok({ sessions: sessions.map(toSessionDto) });
  } catch (err) {
    return errorResponse(err);
  }
}

const createSchema = z.object({
  serverId: z.string().min(1),
  projectName: z.string().trim().min(1).max(63),
  /** Shared Postgres / S3 resources to reserve a namespace on. */
  resourceIds: z.array(z.string().min(1)).max(8).default([]),
  /** Starter template id — see lib/templates.ts */
  template: z.string().max(40).default("blank"),
});

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const body = createSchema.parse(await request.json());
    const projectName = normalizeProjectName(body.projectName);
    if (!projectName) {
      return badRequest("Please pick a project name that contains at least one letter or digit.");
    }

    const session = await createSession({
      serverId: body.serverId,
      projectName,
      resourceIds: body.resourceIds,
      template: body.template,
    });
    startMonitor();

    const full = await prisma.session.findUnique({
      where: { id: session.id },
      include: {
        server: true,
        allocations: { include: { resource: true } },
        links: { orderBy: { createdAt: "asc" } },
      },
    });
    return ok({ session: full ? toSessionDto(full) : null, projectName });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    return errorResponse(err);
  }
}
