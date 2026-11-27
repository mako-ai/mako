CREATE TABLE "apps_box_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"since" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_catalog_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "model_catalog_snapshots_id_check" CHECK ("model_catalog_snapshots"."id" IN ('gateway', 'gateway-raw', 'arena', 'pricing', 'curation', 'capabilities'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"trigger" text NOT NULL,
	"channel_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"http_status" integer,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" IN ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"imported_from_mongo" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"triggers" text[] NOT NULL,
	"channel" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_resource_type_check" CHECK ("notification_rules"."resource_type" IN ('scheduled_query', 'flow'))
);
--> statement-breakpoint
CREATE TABLE "workflow_recorded_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_recorded_writes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text,
	"connection_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"step" text,
	"request" jsonb NOT NULL,
	"seq" integer NOT NULL,
	"body_cut" boolean,
	"would_send" boolean,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recorded_runs" ADD CONSTRAINT "workflow_recorded_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recorded_writes" ADD CONSTRAINT "workflow_recorded_writes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_ws_resource_completed" ON "notification_deliveries" USING btree ("workspace_id","resource_type","resource_id","completed_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_created_at" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_rules_ws_resource_enabled" ON "notification_rules" USING btree ("workspace_id","resource_type","resource_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_recorded_runs_ws_run" ON "workflow_recorded_runs" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_recorded_runs_at" ON "workflow_recorded_runs" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_recorded_writes_ws_run_seq" ON "workflow_recorded_writes" USING btree ("workspace_id","run_id","seq");--> statement-breakpoint
CREATE INDEX "idx_workflow_recorded_writes_at" ON "workflow_recorded_writes" USING btree ("at");