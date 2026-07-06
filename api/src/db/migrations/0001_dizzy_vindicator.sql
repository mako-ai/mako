DROP INDEX "query_executions_created_at_idx";--> statement-breakpoint
DROP INDEX "query_executions_workspace_idx";--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "cost_usd" SET DATA TYPE double precision USING "cost_usd"::double precision;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "query_executions" ADD COLUMN "executed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "query_executions" ADD COLUMN "database_name" text;--> statement-breakpoint
ALTER TABLE "query_executions" ADD COLUMN "bytes_scanned" bigint;--> statement-breakpoint
ALTER TABLE "query_executions" ADD COLUMN "error_type" text;--> statement-breakpoint
CREATE INDEX "query_executions_executed_at_idx" ON "query_executions" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "query_executions_workspace_idx" ON "query_executions" USING btree ("workspace_id","executed_at");--> statement-breakpoint
ALTER TABLE "llm_usage" DROP COLUMN "cache_tokens";--> statement-breakpoint
ALTER TABLE "query_executions" DROP COLUMN "bytes_processed";--> statement-breakpoint
ALTER TABLE "query_executions" DROP COLUMN "error";