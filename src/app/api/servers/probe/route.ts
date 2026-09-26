import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { badRequest, errorResponse, ok } from "@/lib/api";
import { probeDraft } from "@/lib/servers";
import { encryptSecret } from "@/lib/crypto";
import { isSafeAbsolutePath, normalizeRoot } from "@/lib/shell";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1),
  /** Omit together with `serverId` to reuse an already stored key. */
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  projectRoot: z.string().trim().min(1),
  serverId: z.string().optional(),
});

/** Try a connection for a server that has not been saved yet. */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const body = schema.parse(await request.json());

    const projectRoot = normalizeRoot(body.projectRoot);
    if (!isSafeAbsolutePath(projectRoot)) {
      return badRequest("The project root has to be an absolute path.");
    }

    let privateKey = body.privateKey?.trim();
    let passphrase = body.passphrase;
    if (!privateKey && body.serverId) {
      const stored = await prisma.server.findUnique({ where: { id: body.serverId } });
      if (!stored) return badRequest("Unknown server.");
      privateKey = decryptSecret(stored.privateKey);
      passphrase = stored.passphrase ? decryptSecret(stored.passphrase) : undefined;
    }
    if (!privateKey) return badRequest("An SSH private key is required.");

    const probe = await probeDraft({
      // Empty id marks this as a throwaway connection: no host key is pinned.
      id: "",
      host: body.host,
      port: body.port,
      username: body.username,
      privateKey: encryptSecret(privateKey + "\n"),
      passphrase: passphrase ? encryptSecret(passphrase) : null,
      hostKeyFingerprint: null,
    });

    return ok({ probe });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return badRequest(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    }
    return errorResponse(err);
  }
}
