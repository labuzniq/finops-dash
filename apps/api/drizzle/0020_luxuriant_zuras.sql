DROP TABLE IF EXISTS "gateway_breakdown_daily" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_budget" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_budget_history" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_daily" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_deployment_health" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_deployment_health_history" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_exception_daily" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_exception_sweep" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_latency_daily" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_model" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_month" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_month_line" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_notification" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_slow_response_daily" CASCADE;--> statement-breakpoint
DELETE FROM "refresh_jobs" WHERE "kind"::text = 'gateway';--> statement-breakpoint
ALTER TABLE "refresh_jobs" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "refresh_jobs" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "refresh_kind";--> statement-breakpoint
CREATE TYPE "refresh_kind" AS ENUM('copilot', 'jira', 'billing', 'members');--> statement-breakpoint
ALTER TABLE "refresh_jobs" ALTER COLUMN "kind" SET DATA TYPE "refresh_kind" USING "kind"::"refresh_kind";--> statement-breakpoint
ALTER TABLE "refresh_jobs" ALTER COLUMN "kind" SET DEFAULT 'copilot';
