import crypto from "node:crypto";

/**
 * SSH private keys are the crown jewels of this app: whoever holds them owns
 * every managed server. They are stored AES-256-GCM encrypted and only ever
 * decrypted inside the SSH layer — no API route returns them, in any form.
 */

const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.NL_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "NL_ENCRYPTION_KEY is missing or shorter than 32 characters. " +
        "Generate one with: openssl rand -base64 48",
    );
  }
  // Derive a fixed-length key so any sufficiently long secret works.
  cachedKey = crypto.createHash("sha256").update(raw, "utf8").digest();
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(blob: string): string {
  const [version, ivB64, tagB64, dataB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored secret is malformed or was encrypted with another key version.");
  }
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Fingerprint shown in the UI so a key can be recognised without exposing it. */
export function keyFingerprint(privateKeyPem: string): string {
  return (
    "SHA256:" +
    crypto.createHash("sha256").update(privateKeyPem.trim()).digest("base64").slice(0, 24)
  );
}

export function encryptionKeyConfigured(): boolean {
  const raw = process.env.NL_ENCRYPTION_KEY;
  return typeof raw === "string" && raw.length >= 32;
}
