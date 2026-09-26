import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * The datasource URL lives here rather than in the schema, which is how
 * Prisma 7 wants it.
 *
 * The fallback matters: `npm install` runs `prisma generate` through
 * postinstall, and on a fresh clone that happens *before* `.env` exists. Using
 * `env("DATABASE_URL")` here would make the very first install fail.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/nolaptop.db",
  },
});
