/**
 * Post-backfill DDL steps (outside the Drizzle journal).
 *
 * Some constraints can only be attached once a domain backfill has finished,
 * otherwise live Stage 2/4 writes in another domain would fail with 23503.
 * Each step is an idempotent SQL file in `./post-backfill/` (bundled into
 * `dist/` by `api/scripts/copy-build-assets.mjs`) run explicitly by an operator:
 *
 *   pnpm --filter api run pg:migrate -- --post-backfill <step>
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { MakoPgDb } from "./client";

export interface PostBackfillStep {
  /** CLI name (`--post-backfill <name>`). */
  name: string;
  /** SQL file under `post-backfill/`. */
  file: string;
  /** Precondition the operator must have satisfied before running it. */
  requires: string;
}

export const POST_BACKFILL_STEPS: readonly PostBackfillStep[] = [
  {
    name: "sessions-active-workspace-fk",
    file: "0003a_sessions_workspace_fk.sql",
    requires:
      "workspaces_core backfill completed (all workspaces present in Postgres)",
  },
];

export function resolvePostBackfillFolder(customFolder?: string): string {
  return customFolder
    ? path.resolve(customFolder)
    : path.resolve(__dirname, "post-backfill");
}

export function getPostBackfillStep(name: string): PostBackfillStep {
  const step = POST_BACKFILL_STEPS.find(s => s.name === name);
  if (!step) {
    throw new Error(
      `Unknown post-backfill step "${name}". Known steps: ${POST_BACKFILL_STEPS.map(s => s.name).join(", ")}`,
    );
  }
  return step;
}

/** Read a step's SQL and split it on Drizzle statement breakpoints. */
export function readPostBackfillStatements(
  name: string,
  customFolder?: string,
): string[] {
  const step = getPostBackfillStep(name);
  const file = path.join(resolvePostBackfillFolder(customFolder), step.file);
  if (!fs.existsSync(file)) {
    throw new Error(`Post-backfill SQL file not found: ${file}`);
  }
  return fs
    .readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map(s => s.trim())
    .filter(s => s.replace(/--[^\n]*\n?/g, "").trim().length > 0);
}

/** Run a post-backfill step statement by statement (each is idempotent). */
export async function runPostBackfillStep(
  db: MakoPgDb,
  name: string,
  customFolder?: string,
): Promise<{ name: string; statements: number }> {
  const statements = readPostBackfillStatements(name, customFolder);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  return { name, statements: statements.length };
}
