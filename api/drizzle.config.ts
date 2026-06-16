import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for Mako's Postgres metadata store.
 *
 * Generate a migration after editing `src/db/schema/*`:
 *   pnpm --filter api run db:generate
 * Apply migrations:
 *   pnpm --filter api run db:migrate
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.POSTGRES_URL ||
      process.env.PG_DATABASE_URL ||
      "postgres://postgres@127.0.0.1:5432/mako_dev",
  },
});
