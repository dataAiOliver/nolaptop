import { prisma } from "@/lib/db";
import { configurationProblem, isAuthenticated } from "@/lib/auth";
import { errorResponse, ok } from "@/lib/api";
import { encryptionKeyConfigured } from "@/lib/crypto";
import { monitorStatus, startMonitor } from "@/lib/monitor";
import { subscriberCount } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const problem = configurationProblem();
    if (problem) {
      return ok({ authenticated: false, setupRequired: true, problem });
    }
    const authed = await isAuthenticated();
    if (!authed) {
      return ok({ authenticated: false, passwordRequired: true });
    }
    startMonitor();
    const [servers, sessions] = await Promise.all([
      prisma.server.count(),
      prisma.session.count(),
    ]);
    return ok({
      authenticated: true,
      passwordRequired: true,
      encryptionKeyConfigured: encryptionKeyConfigured(),
      servers,
      sessions,
      monitor: monitorStatus(),
      liveClients: subscriberCount(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
