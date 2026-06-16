CREATE TABLE "desktop_auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"active_workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"hashed_password" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"onboarding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"is_default_membership" boolean,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" uuid NOT NULL,
	"settings" jsonb,
	"billing" jsonb,
	"self_directive" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"config" jsonb,
	"settings" jsonb,
	"target_databases" uuid[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"connection" jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "console_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"access" text,
	"owner_id" uuid,
	"is_private" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_consoles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"folder_id" uuid,
	"connection_id" uuid,
	"database_name" text,
	"database_id" text,
	"name" text NOT NULL,
	"description" text,
	"description_embedding" vector(1536),
	"language" text,
	"code" text,
	"chart_spec" jsonb,
	"mongo_options" jsonb,
	"last_run" jsonb,
	"access" text,
	"workspace_role" text,
	"shared_with" jsonb,
	"schedule" jsonb,
	"scheduled_run" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"draft_revision" integer,
	"is_saved" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_by" uuid,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid,
	"created_by" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text,
	"filename" text,
	"size" bigint,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"thread_id" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_agent" text,
	"pinned_console_id" uuid,
	"active_stream_id" text,
	"system_prompt" text,
	"workspace_prompt" text,
	"usage" jsonb,
	"title_generated" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid,
	"invocation_type" text NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_tokens" bigint,
	"reasoning_tokens" bigint,
	"total_tokens" bigint,
	"cost_usd" text,
	"steps" jsonb,
	"agent_id" text,
	"tags" text[],
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"console_id" uuid,
	"source" text,
	"database_type" text,
	"query_language" text,
	"status" text,
	"row_count" bigint,
	"duration_ms" bigint,
	"bytes_processed" bigint,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_auth_codes" ADD CONSTRAINT "desktop_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_keys" ADD CONSTRAINT "workspace_api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_folders" ADD CONSTRAINT "console_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_consoles" ADD CONSTRAINT "saved_consoles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_consoles" ADD CONSTRAINT "saved_consoles_folder_id_console_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."console_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_consoles" ADD CONSTRAINT "saved_consoles_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_executions" ADD CONSTRAINT "query_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_executions" ADD CONSTRAINT "query_executions_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_executions" ADD CONSTRAINT "query_executions_console_id_saved_consoles_id_fk" FOREIGN KEY ("console_id") REFERENCES "public"."saved_consoles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_auth_codes_expires_at_idx" ON "desktop_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_verifications_email_idx" ON "email_verifications" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_verifications_expires_at_idx" ON "email_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_provider_user_unique" ON "oauth_accounts" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "oauth_user_id_idx" ON "oauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_api_keys_hash_unique" ON "workspace_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "workspace_api_keys_workspace_idx" ON "workspace_api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_token_unique" ON "workspace_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "workspace_invites_workspace_idx" ON "workspace_invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workspaces_created_by_idx" ON "workspaces" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "connectors_workspace_idx" ON "connectors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "database_connections_workspace_idx" ON "database_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "console_folders_workspace_idx" ON "console_folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "console_folders_parent_idx" ON "console_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "saved_consoles_workspace_idx" ON "saved_consoles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "saved_consoles_folder_idx" ON "saved_consoles" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "saved_consoles_connection_idx" ON "saved_consoles" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "chat_attachments_workspace_idx" ON "chat_attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chat_attachments_chat_idx" ON "chat_attachments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chats_workspace_idx" ON "chats" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_thread_id_unique" ON "chats" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "llm_usage_workspace_idx" ON "llm_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "llm_usage_chat_idx" ON "llm_usage" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "query_executions_workspace_idx" ON "query_executions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "query_executions_connection_idx" ON "query_executions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "query_executions_console_idx" ON "query_executions" USING btree ("console_id");--> statement-breakpoint
CREATE INDEX "query_executions_created_at_idx" ON "query_executions" USING btree ("created_at");