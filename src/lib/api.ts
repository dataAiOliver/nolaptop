import { NextResponse } from "next/server";
import { NotConfiguredError, UnauthorizedError } from "./auth";
import { SessionError } from "./sessions";
import { SshError } from "./ssh";

/** Turn an exception into an honest HTTP response, without leaking internals. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof NotConfiguredError) {
    return NextResponse.json({ error: err.message, setupRequired: true }, { status: 503 });
  }
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (err instanceof SessionError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof SshError) {
    return NextResponse.json({ error: err.message, kind: err.kind }, { status: 502 });
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[nolaptop]", err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export function ok<T>(data: T): NextResponse {
  return NextResponse.json(data);
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
