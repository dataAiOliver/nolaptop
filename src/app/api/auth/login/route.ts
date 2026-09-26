import { NextRequest } from "next/server";
import { z } from "zod";
import { checkPassword, configurationProblem, createSessionCookie } from "@/lib/auth";
import { NextResponse } from "next/server";
import { badRequest, errorResponse, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1) });

/** Deliberately slow to answer, so guessing over the network is unattractive. */
export async function POST(request: NextRequest) {
  try {
    const problem = configurationProblem();
    if (problem) return NextResponse.json({ error: problem, setupRequired: true }, { status: 503 });
    const { password } = schema.parse(await request.json());

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!checkPassword(password)) return badRequest("Wrong password.");

    await createSessionCookie();
    return ok({ authenticated: true });
  } catch (err) {
    if (err instanceof z.ZodError) return badRequest("Please enter a password.");
    return errorResponse(err);
  }
}
