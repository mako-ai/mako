/**
 * Shared `.env` loader for migration CLI entrypoints (`pg:migrate`, `pg:backfill`, `pg:verify`).
 *
 * `scripts/neon-branch.ts` and `api/src/index.ts` keep `.env` at the repository root,
 * whereas `pnpm --filter api run pg:*` executes with `cwd = api/`. Load repo-root `.env`
 * first (without overriding existing process env vars), then optional `api/.env`.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadMigrationCliEnv(): void {
  const candidates = [
    path.resolve(__dirname, "../../../../.env"), // repo root
    path.resolve(__dirname, "../../../.env"), // api/.env fallback
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
    }
  }
}
