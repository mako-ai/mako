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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MakoPgDb } from "./client";
import {
  GLOBAL_SCOPE_KEY,
  migrationBackfillJobs,
  migrationQuarantine,
} from "./schema/control-plane";

export interface PostBackfillStep {
  /** CLI name (`--post-backfill <name>`). */
  name: string;
  /** SQL file under `post-backfill/`. */
  file: string;
  /** Precondition the operator must have satisfied before running it. */
  requires: string;
  /** Optional runtime guard enforced before executing the step (bypassed only with `force: true`). */
  assertPrecondition?: (db: MakoPgDb) => Promise<void>;
}

async function assertWorkspacesCoreBackfillReady(db: MakoPgDb): Promise<void> {
  const [job] = await db
    .select({
      status: migrationBackfillJobs.status,
    })
    .from(migrationBackfillJobs)
    .where(
      and(
        eq(migrationBackfillJobs.domain, "workspaces_core"),
        eq(migrationBackfillJobs.scopeKey, GLOBAL_SCOPE_KEY),
      ),
    )
    .limit(1);

  if (!job || job.status !== "completed") {
    const actualStatus = job?.status ?? "not_started";
    throw new Error(
      `Refusing to run post-backfill step "sessions-active-workspace-fk": ` +
        `workspaces_core backfill status is "${actualStatus}" (must be "completed"). ` +
        `Running early would permanently clear sessions.active_workspace_id for workspaces not yet copied. ` +
        `Complete the workspaces_core backfill first, or pass --force to override.`,
    );
  }

  const [quarantineRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(migrationQuarantine)
    .where(
      and(
        inArray(migrationQuarantine.domain, [
          "workspaces_core",
          "workspaces_core:workspaces",
        ]),
        eq(migrationQuarantine.collectionName, "workspaces"),
        isNull(migrationQuarantine.resolvedAt),
      ),
    );
  const quarantinedCount = Number(quarantineRow?.count ?? 0);
  if (quarantinedCount > 0) {
    throw new Error(
      `Refusing to run post-backfill step "sessions-active-workspace-fk": ` +
        `${quarantinedCount} unresolved quarantined workspace row(s) exist in migration_quarantine. ` +
        `Resolve them first so active sessions are not cleared, or pass --force to override.`,
    );
  }
}

export const POST_BACKFILL_STEPS: readonly PostBackfillStep[] = [
  {
    name: "sessions-active-workspace-fk",
    file: "0003a_sessions_workspace_fk.sql",
    requires:
      "workspaces_core backfill completed (all workspaces present in Postgres and no unresolved workspace quarantine rows)",
    assertPrecondition: assertWorkspacesCoreBackfillReady,
  },
  {
    name: "consoles-connection-fk",
    file: "0005a_consoles_connection_fk.sql",
    requires:
      "connections and consoles_charts backfills completed (all database_connections and saved_consoles present in Postgres)",
  },
  {
    name: "conn-verif-connection-fk",
    file: "0006a_conn_verif_connection_fk.sql",
    requires:
      "connections (0004) and usage_stats (0006) backfills completed (all database_connections present in Postgres)",
  },
  {
    name: "llm-usage-chat-fk",
    file: "0008a_llm_usage_chat_fk.sql",
    requires:
      "all workspaces have `chat` in Stage >= 2 and `chats` backfill completed",
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

export interface RunPostBackfillStepOptions {
  customFolder?: string;
  /** Bypass step precondition checks (explicit operator override via `--force`). */
  force?: boolean;
}

/** Run a post-backfill step statement by statement (each is idempotent). */
export async function runPostBackfillStep(
  db: MakoPgDb,
  name: string,
  options?: string | RunPostBackfillStepOptions,
): Promise<{ name: string; statements: number }> {
  const opts: RunPostBackfillStepOptions =
    typeof options === "string" ? { customFolder: options } : (options ?? {});
  const step = getPostBackfillStep(name);
  if (!opts.force && step.assertPrecondition) {
    await step.assertPrecondition(db);
  }
  const statements = readPostBackfillStatements(name, opts.customFolder);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  return { name, statements: statements.length };
}
