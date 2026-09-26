import { clearSessionCookie } from "@/lib/auth";
import { errorResponse, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await clearSessionCookie();
    return ok({ authenticated: false });
  } catch (err) {
    return errorResponse(err);
  }
}
