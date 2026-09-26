import crypto from "node:crypto";
import { cookies } from "next/headers";

/**
 * A single shared password for the whole app.
 *
 * There are no user accounts — this is a control panel for one operator. But
 * what it controls is SSH access to every server you add, so it is *not*
 * optional: with no password set, the app serves nothing but a setup notice.
 * An open instance of this would be a remote shell for whoever finds the port.
 */

/** Why the app cannot serve yet, or null when it is properly configured. */
export function configurationProblem(): string | null {
  const key = process.env.NL_ENCRYPTION_KEY ?? "";
  const password = process.env.NL_APP_PASSWORD ?? "";
  if (key.length < 32) {
    return "NL_ENCRYPTION_KEY is missing or shorter than 32 characters. Without it, SSH keys cannot be stored safely.";
  }
  if (password.length < 8) {
    return "NL_APP_PASSWORD is missing or shorter than 8 characters. NoLaptop holds SSH keys for your servers and will not run unprotected.";
  }
  return null;
}

export function isConfigured(): boolean {
  return configurationProblem() === null;
}

const COOKIE = "nl_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function passwordConfigured(): boolean {
  return Boolean(process.env.NL_APP_PASSWORD);
}

function signingKey(): Buffer {
  const secret = `${process.env.NL_APP_PASSWORD ?? ""}:${process.env.NL_ENCRYPTION_KEY ?? ""}`;
  return crypto.createHash("sha256").update(secret).digest();
}

function mint(expiresAt: number): string {
  const payload = String(expiresAt);
  const mac = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.NL_APP_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Compare hashes so differing lengths do not throw and do not leak length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function createSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, mint(Date.now() + MAX_AGE_SECONDS * 1000), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production" && process.env.NL_ALLOW_INSECURE_COOKIE !== "1",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  // An unconfigured instance is never "authenticated" — it is broken, and
  // treating it as open would be the one mistake that really matters here.
  if (!isConfigured()) return false;
  const store = await cookies();
  return verify(store.get(COOKIE)?.value);
}

/** Throws a Response-shaped error for API routes. */
export async function requireAuth(): Promise<void> {
  const problem = configurationProblem();
  if (problem) throw new NotConfiguredError(problem);
  if (await isAuthenticated()) return;
  throw new UnauthorizedError();
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "UnauthorizedError";
  }
}
