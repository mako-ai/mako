-- Post-backfill step for Phase 3 (NOT part of the Drizzle journal).
--
-- Attaches llm_usage.chat_id -> chats(id) ON DELETE SET NULL only once ALL
-- workspaces have `chat` in Stage >= 2 and the `chats` backfill has completed.
-- Running it earlier would fail live `llm_usage` inserts with 23503 whenever
-- a workspace runs `usage_stats` on Postgres while `chat` is still `mongo_only`.
--
-- Idempotent: safe to re-run. Run via:
--   pnpm --filter api run pg:migrate -- --post-backfill llm-usage-chat-fk

-- 1. Null out dangling chat references (chat deleted or not migrated).
UPDATE "llm_usage" lu
   SET "chat_id" = NULL
 WHERE lu."chat_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "chats" c WHERE c."id" = lu."chat_id"
   );
--> statement-breakpoint
-- 2. Attach NOT VALID (no long ACCESS EXCLUSIVE scan), then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_llm_usage_chat'
  ) THEN
    ALTER TABLE "llm_usage"
      ADD CONSTRAINT "fk_llm_usage_chat"
      FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "fk_llm_usage_chat";
