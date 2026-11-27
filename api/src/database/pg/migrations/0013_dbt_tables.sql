CREATE TABLE "dbt_env_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"backfill_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dbt_env_preferences_project_user_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "dbt_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"source_blob_sha" text,
	"definition_invalid" jsonb,
	"environment" text NOT NULL,
	"commands" text[] DEFAULT '{}'::text[] NOT NULL,
	"schedule" jsonb,
	"scheduled_run" jsonb,
	"scheduled_run_next_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"defer_to_production" boolean DEFAULT false NOT NULL,
	"lane" text,
	"lane_evaluated_at" timestamp with time zone,
	"lane_median_ms" bigint,
	"created_by_user_id" uuid,
	"created_by" text NOT NULL,
	"backfill_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dbt_jobs_lane_check" CHECK ("dbt_jobs"."lane" IS NULL OR "dbt_jobs"."lane" IN ('default', 'fast'))
);
--> statement-breakpoint
CREATE TABLE "dbt_projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dbt_version" text DEFAULT '1.12' NOT NULL,
	"environments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_environment" text DEFAULT 'dev' NOT NULL,
	"prod_environment" text,
	"last_prod_manifest_key" text,
	"last_prod_manifest_committed_at" timestamp with time zone,
	"last_prod_manifest_sha" text,
	"environments_invalid" jsonb,
	"created_by_user_id" uuid,
	"created_by" text NOT NULL,
	"backfill_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dbt_projects_ws_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "dbt_projects_environments_check" CHECK (jsonb_typeof("dbt_projects"."environments") = 'array')
);
--> statement-breakpoint
CREATE TABLE "dbt_run_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq_start" integer NOT NULL,
	"seq_end" integer NOT NULL,
	"lines" jsonb NOT NULL,
	CONSTRAINT "dbt_run_logs_seq_check" CHECK ("dbt_run_logs"."seq_start" >= 0 AND "dbt_run_logs"."seq_end" > "dbt_run_logs"."seq_start")
);
--> statement-breakpoint
CREATE TABLE "dbt_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid,
	"environment" text NOT NULL,
	"commands" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" text NOT NULL,
	"actor" jsonb,
	"lane" text,
	"git_branch" text,
	"working_tree_user_id" text,
	"source_branch" text,
	"source_sha" text,
	"defer_to_production" boolean,
	"local_overlay" jsonb,
	"ci" jsonb,
	"deploys_after_run" jsonb,
	"deploys_after_workspace_id" uuid,
	"deploys_after_sha" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" bigint,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"log_total" integer DEFAULT 0 NOT NULL,
	"step_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"artifact_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retry_of_run_id" uuid,
	"restore_artifact_keys" jsonb,
	"error" text,
	"warnings" text[],
	"inngest_run_id" text,
	"backfill_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dbt_runs_status_check" CHECK ("dbt_runs"."status" IN ('queued', 'running', 'success', 'error', 'cancelled')),
	CONSTRAINT "dbt_runs_trigger_check" CHECK ("dbt_runs"."trigger" IN ('schedule', 'manual', 'agent', 'ci')),
	CONSTRAINT "dbt_runs_lane_check" CHECK ("dbt_runs"."lane" IS NULL OR "dbt_runs"."lane" IN ('default', 'fast')),
	CONSTRAINT "dbt_runs_step_results_check" CHECK (jsonb_typeof("dbt_runs"."step_results") = 'array')
);
--> statement-breakpoint
ALTER TABLE "dbt_env_preferences" ADD CONSTRAINT "dbt_env_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_env_preferences" ADD CONSTRAINT "dbt_env_preferences_project_id_dbt_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dbt_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_env_preferences" ADD CONSTRAINT "dbt_env_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_jobs" ADD CONSTRAINT "dbt_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_jobs" ADD CONSTRAINT "dbt_jobs_project_id_dbt_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dbt_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_jobs" ADD CONSTRAINT "dbt_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_run_logs" ADD CONSTRAINT "dbt_run_logs_run_id_dbt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."dbt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_runs" ADD CONSTRAINT "dbt_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_runs" ADD CONSTRAINT "dbt_runs_project_id_dbt_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dbt_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_runs" ADD CONSTRAINT "dbt_runs_job_id_dbt_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."dbt_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dbt_env_preferences_user" ON "dbt_env_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_dbt_jobs_ws_project" ON "dbt_jobs" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dbt_jobs_project_slug_unique" ON "dbt_jobs" USING btree ("project_id","slug") WHERE "dbt_jobs"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dbt_jobs_due" ON "dbt_jobs" USING btree ("scheduled_run_next_at") WHERE "dbt_jobs"."enabled" = true AND "dbt_jobs"."scheduled_run_next_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dbt_projects_ws_updated" ON "dbt_projects" USING btree ("workspace_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_dbt_run_logs_run_seq" ON "dbt_run_logs" USING btree ("run_id","seq_end");--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_ws_project_created" ON "dbt_runs" USING btree ("workspace_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_ws_created" ON "dbt_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_job_created" ON "dbt_runs" USING btree ("job_id","created_at" DESC NULLS LAST) WHERE "dbt_runs"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_active_lane" ON "dbt_runs" USING btree ("project_id","lane","status") WHERE "dbt_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_deploys_after" ON "dbt_runs" USING btree ("deploys_after_workspace_id","deploys_after_sha") WHERE "dbt_runs"."deploys_after_sha" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dbt_runs_completed" ON "dbt_runs" USING btree ("completed_at") WHERE "dbt_runs"."completed_at" IS NOT NULL;