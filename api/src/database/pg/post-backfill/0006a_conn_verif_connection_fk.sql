-- Post-backfill step for Phase 2B (NOT part of the Drizzle journal).
--
-- Attaches connection_verifications.connection_id -> database_connections(id)
-- ON DELETE SET NULL only once both `connections` (0004) and `usage_stats` (0006)
-- backfills have completed. Running it earlier would make verification writes
-- referencing a not-yet-backfilled connection fail with 23503.
--
-- Idempotent: safe to re-run. Run via:
--   pnpm --filter api run pg:migrate -- --post-backfill conn-verif-connection-fk

-- 1. Null out dangling references (deleted or unsaved connection IDs).
UPDATE "connection_verifications" cv
   SET "connection_id" = NULL
 WHERE cv."connection_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "database_connections" dc WHERE dc."id" = cv."connection_id"
   );
--> statement-breakpoint
-- 2. Attach NOT VALID (no long ACCESS EXCLUSIVE scan), then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'connection_verifications_connection_id_fk'
  ) THEN
    ALTER TABLE "connection_verifications"
      ADD CONSTRAINT "connection_verifications_connection_id_fk"
      FOREIGN KEY ("connection_id") REFERENCES "database_connections"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "connection_verifications" VALIDATE CONSTRAINT "connection_verifications_connection_id_fk";
