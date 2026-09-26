import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptSecret, encryptionKeyConfigured } from "@/lib/crypto";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeServer, toPublicServer } from "@/lib/servers";
import { isSafeAbsolutePath, normalizeRoot } from "@/lib/shell";
import { validateEditorConfig } from "@/lib/editor";
import { serversChanged } from "@/lib/events";
import { startMonitor } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64),
  privateKey: z.string().min(1),
  passphrase: z.string().optional(),
  projectRoot: z.string().trim().min(1).max(512),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().default(true),
  agentsFileName: z.enum(["AGENTS.md", "CLAUDE.md"]).default("AGENTS.md"),
  agentsPreamble: z.string().trim().max(4000).optional().nullable(),
  editorMode: z.enum(["NONE", "TUNNEL", "CODE_SERVER", "DESKTOP_SSH", "CUSTOM"]).default("NONE"),
  editorBaseUrl: z.string().trim().max(300).optional().nullable(),
  editorTunnelName: z.string().trim().max(120).optional().nullable(),
  editorSshHost: z.string().trim().max(200).optional().nullable(),
  editorUrlTemplate: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  try {
    await requireAuth();
    startMonitor();
    const servers = await prisma.server.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { sessions: true } } },
    });
    return ok({ servers: servers.map((s) => toPublicServer(s, s._count.sessions)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    if (!encryptionKeyConfigured()) {
      return badRequest(
        "NL_ENCRYPTION_KEY is not set. Without it SSH keys cannot be stored safely, so adding a server is refused.",
      );
    }

    const body = createSchema.parse(await request.json());
    const projectRoot = normalizeRoot(body.projectRoot);
    if (!isSafeAbsolutePath(projectRoot)) {
      return badRequest("The project root has to be an absolute path, e.g. /home/deploy/projects.");
    }
    if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(body.privateKey)) {
      return badRequest("That does not look like an OpenSSH private key.");
    }
    const editorError = validateEditorConfig(body);
    if (editorError) return badRequest(editorError);

    const server = await prisma.server.create({
      data: {
        name: body.name,
        host: body.host,
        port: body.port,
        username: body.username,
        privateKey: encryptSecret(body.privateKey.trim() + "\n"),
        passphrase: body.passphrase ? encryptSecret(body.passphrase) : null,
        projectRoot,
        description: body.description ?? null,
        active: body.active,
        agentsFileName: body.agentsFileName,
        agentsPreamble: body.agentsPreamble ?? null,
        editorMode: body.editorMode,
        editorBaseUrl: body.editorBaseUrl ?? null,
        editorTunnelName: body.editorTunnelName ?? null,
        editorSshHost: body.editorSshHost ?? null,
        editorUrlTemplate: body.editorUrlTemplate ?? null,
      },
    });

    serversChanged();
    // Probe straight away so the card is never "Unknown" on the first render.
    void probeServer(server);
    startMonitor();

    return ok({ server: toPublicServer(server, 0) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return badRequest("A server with that name already exists.");
    }
    return errorResponse(err);
  }
}
