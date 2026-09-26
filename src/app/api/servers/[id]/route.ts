import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeServer, toPublicServer } from "@/lib/servers";
import { isSafeAbsolutePath, normalizeRoot } from "@/lib/shell";
import { validateEditorConfig } from "@/lib/editor";
import { dropConnection } from "@/lib/ssh";
import { closeTunnels } from "@/lib/tunnel";
import { serversChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(64).optional(),
  /** Omit to keep the stored key. */
  privateKey: z.string().min(1).optional(),
  passphrase: z.string().optional().nullable(),
  projectRoot: z.string().trim().min(1).max(512).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional(),
  /// Clear the pinned SSH host key, e.g. after the host was legitimately rebuilt.
  forgetHostKey: z.boolean().optional(),
  agentsFileName: z.enum(["AGENTS.md", "CLAUDE.md"]).optional(),
  agentsPreamble: z.string().trim().max(4000).optional().nullable(),
  editorMode: z.enum(["NONE", "TUNNEL", "CODE_SERVER", "DESKTOP_SSH", "CUSTOM"]).optional(),
  editorBaseUrl: z.string().trim().max(300).optional().nullable(),
  editorTunnelName: z.string().trim().max(120).optional().nullable(),
  editorSshHost: z.string().trim().max(200).optional().nullable(),
  editorUrlTemplate: z.string().trim().max(500).optional().nullable(),
});

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({
      where: { id },
      include: { _count: { select: { sessions: true } } },
    });
    if (!server) return badRequest("Unknown server.");
    return ok({ server: toPublicServer(server, server._count.sessions) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const body = patchSchema.parse(await request.json());

    const data: Record<string, unknown> = {};
    for (const field of [
      "name", "host", "port", "username", "description", "active",
      "agentsFileName", "agentsPreamble",
      "editorMode", "editorBaseUrl", "editorTunnelName", "editorSshHost", "editorUrlTemplate",
    ] as const) {
      if (body[field] !== undefined) data[field] = body[field];
    }

    if (body.editorMode !== undefined) {
      const current = await prisma.server.findUnique({ where: { id } });
      if (!current) return badRequest("Unknown server.");
      const editorError = validateEditorConfig({
        editorMode: body.editorMode,
        editorBaseUrl: body.editorBaseUrl ?? current.editorBaseUrl,
        editorTunnelName: body.editorTunnelName ?? current.editorTunnelName,
        editorUrlTemplate: body.editorUrlTemplate ?? current.editorUrlTemplate,
      });
      if (editorError) return badRequest(editorError);
    }
    if (body.projectRoot !== undefined) {
      const root = normalizeRoot(body.projectRoot);
      if (!isSafeAbsolutePath(root)) return badRequest("The project root has to be an absolute path.");
      data.projectRoot = root;
    }
    if (body.privateKey) {
      if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(body.privateKey)) {
        return badRequest("That does not look like an OpenSSH private key.");
      }
      data.privateKey = encryptSecret(body.privateKey.trim() + "\n");
    }
    if (body.forgetHostKey) data.hostKeyFingerprint = null;
    if (body.passphrase !== undefined) {
      data.passphrase = body.passphrase ? encryptSecret(body.passphrase) : null;
    }

    const server = await prisma.server.update({ where: { id }, data });
    dropConnection(id); // Reconnect with the new settings on the next command.
    closeTunnels(id);
    serversChanged();
    void probeServer(server);
    return ok({ server: toPublicServer(server) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    return errorResponse(err);
  }
}

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({
      where: { id },
      include: { _count: { select: { sessions: true } } },
    });
    if (!server) return badRequest("Unknown server.");

    // Deleting a server drops its session records. The tmux sessions on the
    // host are left alone on purpose — this app does not silently kill work.
    await prisma.server.delete({ where: { id } });
    dropConnection(id);
    closeTunnels(id);
    serversChanged();
    return ok({
      deleted: true,
      note:
        server._count.sessions > 0
          ? `${server._count.sessions} session record(s) removed. Any tmux sessions on ${server.host} are still running and were not touched.`
          : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
