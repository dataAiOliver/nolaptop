import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/**
 * SQLite is the right store here: one operator, one process, a few hundred rows.
 * Prisma 7 talks to it through a driver adapter, so the connection string is
 * resolved in code rather than baked into the schema.
 */

/**
 * Find the project root by walking up to the nearest package.json.
 *
 * `next start` does not guarantee the working directory the route handlers run
 * in, so resolving a relative DATABASE_URL against `process.cwd()` alone can
 * land next to the build output instead of next to the schema.
 */
function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function databaseFile(): string {
  const url = process.env.DATABASE_URL ?? "file:./data/nolaptop.db";
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(projectRoot(), raw);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${databaseFile()}` }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
