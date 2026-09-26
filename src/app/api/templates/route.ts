import { requireAuth } from "@/lib/auth";
import { errorResponse, ok } from "@/lib/api";
import { TEMPLATES } from "@/lib/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAuth();
    return ok({
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        label: t.label,
        summary: t.summary,
        needsServices: t.needsServices,
        runs: Boolean(t.start),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
