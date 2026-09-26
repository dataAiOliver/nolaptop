/**
 * Namespace conventions for shared backing services.
 *
 * Every project gets a predictable slice of a shared Postgres or S3 store. The
 * names are derived, never taken from a client, and validated against the
 * stricter of the two sets of rules (Postgres identifiers and S3 bucket names)
 * so the same slug is usable everywhere.
 */

const PREFIX = "proj";

/** Postgres identifiers: lowercase, start with a letter, max 63 bytes. */
export function postgresNamespace(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${PREFIX}_${slug}`.slice(0, 63).replace(/_+$/, "");
}

/**
 * S3 bucket names: 3–63 characters, lowercase letters, digits and hyphens,
 * must start and end alphanumeric, and no underscores or dots (dots break
 * virtual-host-style TLS).
 */
export function s3Bucket(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${PREFIX}-${slug}`.slice(0, 63).replace(/-+$/, "");
  return name.length >= 3 ? name : `${name}-store`;
}

/** Prefix used when many projects share one bucket. */
export function s3Prefix(projectName: string): string {
  return `${s3Bucket(projectName)}/`;
}

export function isValidPostgresIdentifier(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(name);
}

export function isValidBucketName(name: string): boolean {
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) return false;
  // An all-numeric, dotted name would be read as an IP address.
  if (/^\d+(\.\d+){3}$/.test(name)) return false;
  return true;
}

/**
 * Quote a Postgres identifier for use in DDL.
 *
 * The names here are already slug-validated, but DDL cannot be parameterised,
 * so quoting is the only correct way to interpolate one — and it is applied
 * unconditionally rather than trusted to the caller.
 */
export function quoteIdent(name: string): string {
  if (name.includes("\0")) throw new Error("Identifier contains a null byte.");
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a Postgres string literal (for passwords in CREATE ROLE). */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("Value contains a null byte.");
  return `'${value.replace(/'/g, "''")}'`;
}
