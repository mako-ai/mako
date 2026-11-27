-- Phase 3 (Part 2): Normalized Chat domain tables (6 tables)
--   chats, chat_messages, chat_attachments, chat_message_parts,
--   chat_message_part_metadata, chat_usage_entries
--
-- Aligned with binding decisions #3, #7, and #8:
--   - NO `chat_messages.parts jsonb` column (parts live one-row-per-part in `chat_message_parts`).
--   - Provider metadata (Anthropic thinking signatures, tool call/result provider metadata)
--     lives in sparse 1:1 `chat_message_part_metadata` for byte-exact prompt-cache replay.
--   - NO Postgres `chat_stream_events` / `stream_event` table: Redis `resumable-stream` is permanent.
--   - `llm_usage.chat_id -> chats(id) ON DELETE SET NULL` is deferred to
--     `post-backfill/0008a_llm_usage_chat_fk.sql` so cross-domain writes never hit 23503 during rollout.

CREATE TABLE IF NOT EXISTS "chats" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "title" text NOT NULL DEFAULT 'New Chat',
  "title_generated" boolean NOT NULL DEFAULT false,
  "source" text NOT NULL DEFAULT 'chat'
    CONSTRAINT "chats_source_check" CHECK ("source" IN ('chat', 'app', 'workflow')),
  "app_id" uuid,
  "thread_id" text,
  "active_agent" text
    CONSTRAINT "chats_active_agent_check" CHECK (
      "active_agent" IS NULL OR "active_agent" IN ('mongo', 'bigquery', 'triage')
    ),
  "pinned_console_id" uuid,
  "active_stream_id" text,
  "active_stream_alive_at" timestamptz,
  "turn_checkpoint" jsonb,
  "local_acp" jsonb,
  "system_prompt" text,
  "workspace_prompt" text,
  "usage_prompt_tokens" bigint NOT NULL DEFAULT 0,
  "usage_completion_tokens" bigint NOT NULL DEFAULT 0,
  "usage_total_tokens" bigint NOT NULL DEFAULT 0,
  "usage_cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "usage_cache_write_tokens" bigint NOT NULL DEFAULT 0,
  "usage_reasoning_tokens" bigint NOT NULL DEFAULT 0,
  "usage_cost_usd" numeric(14, 8) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chats_user_list"
  ON "chats" ("workspace_id", "created_by", "updated_at" DESC, "id" DESC)
  WHERE "source" = 'chat' AND "created_by" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chats_app_list"
  ON "chats" ("workspace_id", "app_id", "created_by", "updated_at" DESC, "id" DESC)
  WHERE "source" = 'app' AND "app_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_chats_thread_id"
  ON "chats" ("thread_id")
  WHERE "thread_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chats_active_stream"
  ON "chats" ("active_stream_id")
  WHERE "active_stream_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_id" uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL
    CONSTRAINT "chat_messages_ordinal_check" CHECK ("ordinal" >= 0),
  "client_message_id" text,
  "role" text NOT NULL
    CONSTRAINT "chat_messages_role_check" CHECK ("role" IN ('user', 'assistant', 'system')),
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_messages_chat_ordinal_unique" UNIQUE ("chat_id", "ordinal")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_chat_client_id"
  ON "chat_messages" ("chat_id", "client_message_id")
  WHERE "client_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_attachments" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "chat_id" uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "storage_key" text NOT NULL,
  "media_type" text NOT NULL,
  "filename" text,
  "size" bigint NOT NULL
    CONSTRAINT "chat_attachments_size_check" CHECK ("size" >= 0),
  "sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_attachments_dedup_unique" UNIQUE ("workspace_id", "chat_id", "sha256")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_attachments_chat"
  ON "chat_attachments" ("chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_attachments_ws"
  ON "chat_attachments" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_id" uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "order_index" integer NOT NULL
    CONSTRAINT "chat_message_parts_order_index_check" CHECK ("order_index" >= 0),
  "part_type" text NOT NULL
    CONSTRAINT "chat_message_parts_part_type_check" CHECK (
      "part_type" IN (
        'text', 'reasoning', 'file', 'tool',
        'step-start', 'source-url', 'source-document', 'other'
      )
    ),
  "raw_type" text,
  "text_value" text,
  "file_url" text,
  "file_media_type" text,
  "file_filename" text,
  "attachment_id" uuid REFERENCES "chat_attachments"("id") ON DELETE SET NULL,
  "is_dynamic_tool" boolean,
  "tool_call_id" text,
  "tool_name" text,
  "tool_state" text
    CONSTRAINT "chat_message_parts_tool_state_check" CHECK (
      "tool_state" IS NULL OR "tool_state" IN (
        'input-streaming', 'input-available',
        'output-streaming', 'output-available',
        'output-error', 'output-denied',
        'approval-requested', 'approval-responded',
        'error'
      )
    ),
  "tool_input" jsonb,
  "tool_output" jsonb,
  "tool_error_text" text,
  "tool_raw_input" jsonb,
  "tool_approval" jsonb
    CONSTRAINT "chat_message_parts_tool_approval_check" CHECK (
      "tool_approval" IS NULL OR jsonb_typeof("tool_approval") = 'object'
    ),
  "tool_provider_executed" boolean,
  "tool_preliminary" boolean,
  "tool_title" text,
  "tool_metadata" jsonb,
  "extra_payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_message_parts_msg_order_unique" UNIQUE ("message_id", "order_index"),
  CONSTRAINT "chat_message_parts_type_fields_check" CHECK (
    ("part_type" IN ('text', 'reasoning') AND "text_value" IS NOT NULL
      AND "tool_call_id" IS NULL AND "file_url" IS NULL)
    OR ("part_type" = 'file' AND "file_url" IS NOT NULL AND "file_media_type" IS NOT NULL
      AND "tool_call_id" IS NULL)
    OR ("part_type" = 'tool' AND "tool_call_id" IS NOT NULL AND "tool_name" IS NOT NULL
      AND "tool_state" IS NOT NULL AND "is_dynamic_tool" IS NOT NULL)
    OR ("part_type" = 'step-start' AND "tool_call_id" IS NULL AND "file_url" IS NULL)
    OR ("part_type" IN ('source-url', 'source-document') AND "extra_payload" IS NOT NULL)
    OR ("part_type" = 'other' AND "raw_type" IS NOT NULL AND "extra_payload" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_parts_chat_msg_order"
  ON "chat_message_parts" ("chat_id", "message_id", "order_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_parts_chat_tool"
  ON "chat_message_parts" ("chat_id", "tool_name")
  WHERE "part_type" = 'tool';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_parts_tool_call_id"
  ON "chat_message_parts" ("tool_call_id")
  WHERE "tool_call_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_parts_attachment"
  ON "chat_message_parts" ("attachment_id")
  WHERE "attachment_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message_part_metadata" (
  "part_id" uuid PRIMARY KEY REFERENCES "chat_message_parts"("id") ON DELETE CASCADE,
  "provider_metadata" jsonb,
  "call_provider_metadata" jsonb,
  "result_provider_metadata" jsonb,
  CONSTRAINT "chat_part_metadata_non_empty" CHECK (
    "provider_metadata" IS NOT NULL
    OR "call_provider_metadata" IS NOT NULL
    OR "result_provider_metadata" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_usage_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_id" uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "entry_index" integer NOT NULL
    CONSTRAINT "chat_usage_entries_entry_index_check" CHECK ("entry_index" >= 0),
  "assistant_message_index" integer NOT NULL,
  "model" text,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "reasoning_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(14, 8) NOT NULL DEFAULT 0,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_usage_entries_chat_idx_unique" UNIQUE ("chat_id", "entry_index")
);
