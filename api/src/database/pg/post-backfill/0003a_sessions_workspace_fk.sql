-- Post-backfill step for Phase 1B (NOT part of the Drizzle journal).
--
-- Attaches sessions.active_workspace_id -> workspaces(id) ON DELETE SET NULL
-- only once the `workspaces_core` backfill has completed. Running it earlier
-- would make a session write referencing a not-yet-backfilled workspace fail
-- with 23503.
--
-- Idempotent: safe to re-run. Run via:
--   pnpm --filter api run pg:migrate -- --post-backfill sessions-active-workspace-fk

-- 1. Null out dangling references (workspace deleted or invalid legacy value).
UPDATE "sessions" s
   SET "active_workspace_id" = NULL
 WHERE s."active_workspace_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "workspaces" w WHERE w."id" = s."active_workspace_id"
   );
--> statement-breakpoint
-- 2. Attach NOT VALID (no long ACCESS EXCLUSIVE scan), then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sessions_active_workspace_id_fk'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_active_workspace_id_fk"
      FOREIGN KEY ("active_workspace_id") REFERENCES "workspaces"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_active_workspace_id_fk";
