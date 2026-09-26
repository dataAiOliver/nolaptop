import crypto from "node:crypto";
import type { Resource } from "@prisma/client";
import { decryptSecret } from "../crypto";
import { isValidBucketName, s3Bucket, s3Prefix } from "./naming";
import { resolveS3BaseUrl } from "./connect";

/**
 * S3 namespace provisioning, spoken directly to the endpoint.
 *
 * Only plain S3 verbs are used (ListBuckets, HeadBucket, CreateBucket,
 * PutObject), which every S3-compatible store implements — MinIO, Garage,
 * Ceph, AWS, Backblaze. Signing is SigV4, hand-rolled so the app does not pull
 * in the AWS SDK for four requests.
 *
 * What this deliberately does *not* do is mint a per-project access key. That
 * is vendor-specific admin API territory (MinIO's madmin, AWS IAM), so a
 * project gets its own bucket or prefix and the resource's own key. The UI says
 * so plainly rather than implying an isolation that is not there.
 */

export type S3Allocation = {
  bucket: string;
  prefix: string | null;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
};

type SignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function credentials(resource: Resource): { accessKey: string; secretKey: string; region: string } {
  if (!resource.accessKey || !resource.secretKey) {
    throw new Error(`Resource "${resource.name}" is missing its access keys.`);
  }
  return {
    accessKey: resource.accessKey,
    secretKey: decryptSecret(resource.secretKey),
    region: resource.region || "us-east-1",
  };
}

/**
 * The endpoint the *project* uses, which is not necessarily the one we dial:
 * a managed store is tunnelled for us but sits on the server's own localhost.
 */
function projectEndpoint(resource: Resource): string {
  if (resource.serverId) return `http://127.0.0.1:${resource.remotePort ?? 9000}`;
  return (resource.endpoint ?? "").replace(/\/+$/, "");
}

/** Build a SigV4-signed request against `baseUrl` (already tunnel-resolved). */
function sign(
  resource: Resource,
  baseUrl: string,
  opts: { method: string; path: string; query?: string; body?: string },
): SignedRequest {
  const { accessKey, secretKey, region } = credentials(resource);
  const url = new URL(baseUrl);
  const host = url.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const body = opts.body ?? "";
  const payloadHash = sha256Hex(body);

  // The path is built from validated bucket/key names, never raw input.
  const basePath = url.pathname.replace(/\/+$/, "");
  const canonicalUri = `${basePath}${opts.path}` || "/";
  const canonicalQuery = opts.query ?? "";

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (body) headers["content-length"] = String(Buffer.byteLength(body));

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${url.protocol}//${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    method: opts.method,
    headers,
    body: body || undefined,
  };
}

async function send(request: SignedRequest): Promise<{ status: number; text: string }> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, text: await response.text() };
}

export type S3Probe = { ok: boolean; message: string; buckets?: number };

export async function probeS3(resource: Resource): Promise<S3Probe> {
  try {
    const baseUrl = await resolveS3BaseUrl(resource);
    const result = await send(sign(resource, baseUrl, { method: "GET", path: "/" }));
    if (result.status === 200) {
      const buckets = (result.text.match(/<Bucket>/g) ?? []).length;
      return { ok: true, buckets, message: `Connected. ${buckets} bucket(s) visible.` };
    }
    if (result.status === 403) {
      // Listing all buckets is often denied for a scoped key — that is fine.
      return {
        ok: true,
        message: "Connected, but this key may not list buckets. Creating a bucket may still work.",
      };
    }
    return { ok: false, message: `Endpoint answered ${result.status}: ${excerpt(result.text)}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function bucketExists(resource: Resource, baseUrl: string, bucket: string): Promise<boolean> {
  const result = await send(sign(resource, baseUrl, { method: "HEAD", path: `/${bucket}` }));
  if (result.status === 200) return true;
  if (result.status === 404) return false;
  if (result.status === 403) {
    throw new Error(`The endpoint denied access to bucket "${bucket}".`);
  }
  throw new Error(`Unexpected answer ${result.status} while checking bucket "${bucket}".`);
}

export async function allocateS3(resource: Resource, projectName: string): Promise<S3Allocation> {
  const { accessKey, secretKey, region } = credentials(resource);
  const baseUrl = await resolveS3BaseUrl(resource);
  const shared = resource.layout === "SHARED_BUCKET_PREFIX";

  const bucket = shared ? (resource.bucket ?? "").trim() : s3Bucket(projectName);
  if (!bucket) {
    throw new Error(`Resource "${resource.name}" uses a shared bucket but none is configured.`);
  }
  if (!isValidBucketName(bucket)) {
    throw new Error(`"${bucket}" is not a valid S3 bucket name.`);
  }

  if (!(await bucketExists(resource, baseUrl, bucket))) {
    // AWS rejects a LocationConstraint for us-east-1; everything else needs it.
    const body =
      region && region !== "us-east-1"
        ? `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`
        : "";
    const created = await send(sign(resource, baseUrl, { method: "PUT", path: `/${bucket}`, body }));
    if (created.status !== 200 && created.status !== 204) {
      throw new Error(`Could not create bucket "${bucket}" (${created.status}): ${excerpt(created.text)}`);
    }
  }

  const prefix = shared ? s3Prefix(projectName) : null;
  if (prefix) {
    // A zero-byte marker object so the prefix is visible in a browser.
    const marker = await send(sign(resource, baseUrl, { method: "PUT", path: `/${bucket}/${prefix}`, body: "" }));
    if (marker.status !== 200 && marker.status !== 204) {
      throw new Error(`Could not reserve prefix "${prefix}" (${marker.status}).`);
    }
  }

  return {
    bucket,
    prefix,
    endpoint: projectEndpoint(resource),
    region,
    accessKey,
    secretKey,
    forcePathStyle: resource.forcePathStyle,
  };
}

/** Delete an empty project bucket. Only ever on explicit request. */
export async function dropS3Bucket(resource: Resource, bucket: string): Promise<void> {
  if (!isValidBucketName(bucket)) {
    throw new Error(`Refusing to delete an unexpected bucket name: ${bucket}`);
  }
  const baseUrl = await resolveS3BaseUrl(resource);
  const result = await send(sign(resource, baseUrl, { method: "DELETE", path: `/${bucket}` }));
  if (result.status !== 204 && result.status !== 200 && result.status !== 404) {
    throw new Error(
      `Could not delete bucket "${bucket}" (${result.status}). A bucket has to be empty first.`,
    );
  }
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
