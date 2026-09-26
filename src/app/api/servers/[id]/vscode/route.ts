import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import {
  inspectVsCode,
  installVsCodeCli,
  startVsCodeLogin,
  startVsCodeTunnel,
  stopVsCodeTunnel,
} from "@/lib/remote/vscode";
import { serversChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Tunnel names are global to your account, so keep them recognisable. */
function tunnelNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38);
  return slug.length >= 2 ? slug : `nolaptop-${slug}`;
}

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return badRequest("Unknown server.");

    const status = await inspectVsCode(server);
    return ok({ status, suggestedName: tunnelNameFor(server.name) });
  } catch (err) {
    return errorResponse(err);
  }
}

const schema = z.object({ step: z.enum(["install", "login", "start", "stop"]) });

/**
 * The three steps of switching on browser VS Code, each reporting its own log
 * so a failure is visible rather than mysterious.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    await requireAuth();
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return badRequest("Unknown server.");

    const { step } = schema.parse(await request.json());

    if (step === "install") {
      const result = await installVsCodeCli(server);
      const status = await inspectVsCode(server);
      return ok({
        ok: true,
        message: result.installed
          ? "VS Code CLI installed."
          : "A VS Code CLI was already on this host.",
        log: result.log,
        status,
      });
    }

    if (step === "login") {
      const prompt = await startVsCodeLogin(server);
      return ok({
        ok: Boolean(prompt.code),
        message: prompt.code
          ? "Open the link, enter the code, then come back and press Start tunnel."
          : "The CLI did not print a device code. See the log.",
        url: prompt.url,
        code: prompt.code,
        log: prompt.log,
      });
    }

    if (step === "stop") {
      await stopVsCodeTunnel(server);
      await prisma.server.update({
        where: { id },
        data: { editorMode: server.editorMode === "TUNNEL" ? "NONE" : server.editorMode },
      });
      serversChanged();
      const status = await inspectVsCode(server);
      return ok({ ok: true, message: "Tunnel stopped.", status });
    }

    // step === "start"
    const name = tunnelNameFor(server.name);
    const result = await startVsCodeTunnel(server, name);
    if (!result.tunnelName) {
      return ok({
        ok: false,
        message: "The tunnel started but has not reported an address yet. See the log.",
        log: result.log,
        status: await inspectVsCode(server),
      });
    }

    // Point every project on this host at the tunnel from now on.
    await prisma.server.update({
      where: { id },
      data: { editorMode: "TUNNEL", editorTunnelName: result.tunnelName },
    });
    serversChanged();

    return ok({
      ok: true,
      message: `Tunnel "${result.tunnelName}" is up. Session cards now open in the browser.`,
      log: result.log,
      status: await inspectVsCode(server),
    });
  } catch (err) {
    if (err instanceof z.ZodError) return badRequest("Unknown step.");
    return errorResponse(err);
  }
}
