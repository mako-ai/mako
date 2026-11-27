-- Post-backfill step for Phase 2A-2 (`consoles_charts`) — NOT part of the Drizzle journal.
--
-- Attaches `saved_consoles.connection_id -> database_connections(id) ON DELETE SET NULL`
-- only once BOTH `connections` and `consoles_charts` backfills have completed across all
-- workspaces. Attaching it earlier would fail live Stage 2/4 `saved_consoles` writes with
-- 23503 whenever a workspace's `connections` domain is still in `mongo_only`.
--
-- Idempotent: safe to re-run. Run via:
--   pnpm --filter api run pg:migrate -- --post-backfill consoles-connection-fk

-- 1. Clear dangling connection references (deleted or foreign connections).
UPDATE "saved_consoles" sc
   SET "connection_id" = NULL
 WHERE sc."connection_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "database_connections" dc WHERE dc."id" = sc."connection_id"
   );
--> statement-breakpoint
-- 2. Attach NOT VALID (avoids long ACCESS EXCLUSIVE scan), then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'saved_consoles_connection_id_fk'
  ) THEN
    ALTER TABLE "saved_consoles"
      ADD CONSTRAINT "saved_consoles_connection_id_fk"
      FOREIGN KEY ("connection_id") REFERENCES "database_connections"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "saved_consoles" VALIDATE CONSTRAINT "saved_consoles_connection_id_fk";
