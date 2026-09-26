import crypto from "node:crypto";
import { Client, type ClientConfig } from "pg";
import type { Resource } from "@prisma/client";
import { decryptSecret } from "../crypto";
import { isValidPostgresIdentifier, postgresNamespace, quoteIdent, quoteLiteral } from "./naming";
import { resolveEndpoint } from "./connect";

/**
 * Carving a project-sized slice out of one shared Postgres instance.
 *
 * A separate database with its own owning role, rather than a schema inside a
 * shared database: the same amount of work, and a project genuinely cannot see
 * another project's tables.
 */

export type PostgresAllocation = {
  database: string;
  username: string;
  password: string;
  host: string;
  port: number;
  url: string;
};

async function adminConfig(resource: Resource, database?: string): Promise<ClientConfig> {
  if (!resource.adminUser) {
    throw new Error(`Resource "${resource.name}" is missing its admin user.`);
  }
  const sslMode = resource.sslMode ?? "prefer";
  const endpoint = await resolveEndpoint(resource, 5432);
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: resource.adminUser,
    password: resource.adminPassword ? decryptSecret(resource.adminPassword) : undefined,
    database: database ?? resource.adminDatabase ?? "postgres",
    ssl:
      sslMode === "disable" || sslMode === "prefer"
        ? false
        : { rejectUnauthorized: sslMode !== "no-verify" },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
  };
}

async function withAdmin<T>(
  resource: Resource,
  fn: (client: Client) => Promise<T>,
  database?: string,
): Promise<T> {
  const client = new Client(await adminConfig(resource, database));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export type PostgresProbe = {
  ok: boolean;
  message: string;
  version?: string;
  canCreate?: boolean;
};

export async function probePostgres(resource: Resource): Promise<PostgresProbe> {
  try {
    return await withAdmin(resource, async (client) => {
      const version = await client.query<{ version: string }>("SELECT version()");
      const rights = await client.query<{ rolcreatedb: boolean; rolcreaterole: boolean; rolsuper: boolean }>(
        "SELECT rolcreatedb, rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user",
      );
      const row = rights.rows[0];
      const canCreate = Boolean(row && (row.rolsuper || (row.rolcreatedb && row.rolcreaterole)));
      return {
        ok: true,
        canCreate,
        version: version.rows[0]?.version.split(" ").slice(0, 2).join(" "),
        message: canCreate
          ? "Connected, and the admin user may create databases and roles."
          : "Connected, but this user cannot create databases and roles — provisioning will fail.",
      };
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function generatePassword(): string {
  // base64url keeps it shell- and URL-safe, so it can go straight into a .env.
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Create (or adopt) the database and role for one project.
 *
 * Idempotent: running it again on an existing database rotates nothing and
 * fails nothing — it returns the existing namespace with a fresh password only
 * when it had to create the role.
 */
export async function allocatePostgres(
  resource: Resource,
  projectName: string,
): Promise<PostgresAllocation> {
  const database = postgresNamespace(projectName);
  const username = database;
  if (!isValidPostgresIdentifier(database)) {
    throw new Error(`Could not derive a valid Postgres name from "${projectName}".`);
  }

  const password = generatePassword();

  await withAdmin(resource, async (client) => {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [username]);
    if (role.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${quoteIdent(username)} LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
    } else {
      // The role already exists; give it the new password so the project can
      // actually use the credentials this app is about to hand out.
      await client.query(`ALTER ROLE ${quoteIdent(username)} WITH PASSWORD ${quoteLiteral(password)}`);
    }

    const db = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (db.rowCount === 0) {
      // CREATE DATABASE cannot run inside a transaction block.
      await client.query(`CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(username)}`);
    }
  });

  // Lock the public schema down to the owner, inside the new database.
  await withAdmin(
    resource,
    async (client) => {
      await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await client.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(username)}`);
      await client.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(username)}`);
    },
    database,
  );

  // The URL is for the project on the server, so it uses the address that is
  // valid *there* — not the local end of our tunnel.
  const host = resource.serverId ? "127.0.0.1" : (resource.host ?? "");
  const port = resource.serverId ? (resource.remotePort ?? 5432) : (resource.port ?? 5432);
  const sslMode = resource.sslMode ?? "prefer";
  const query = sslMode && sslMode !== "prefer" ? `?sslmode=${encodeURIComponent(sslMode)}` : "";
  const url = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}${query}`;

  return { database, username, password, host, port, url };
}

/**
 * Drop a project's database and role.
 *
 * Never called automatically. Removing a project leaves its data alone; this
 * only runs when someone explicitly asks for the data to be destroyed.
 */
export async function dropPostgres(
  resource: Resource,
  namespace: string,
  username: string | null,
): Promise<void> {
  if (!isValidPostgresIdentifier(namespace)) {
    throw new Error(`Refusing to drop an unexpected database name: ${namespace}`);
  }
  await withAdmin(resource, async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [namespace],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(namespace)}`);
    if (username && isValidPostgresIdentifier(username)) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(username)}`);
    }
  });
}
