CREATE TYPE "plan" AS ENUM('Business', 'Enterprise');--> statement-breakpoint
CREATE TYPE "refresh_kind" AS ENUM('copilot', 'jira');--> statement-breakpoint
CREATE TYPE "refresh_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "adoption_phase_daily" (
	"date" date NOT NULL,
	"phase_number" smallint NOT NULL,
	"phase" varchar(40) NOT NULL,
	"engaged_users" integer NOT NULL,
	"avg_interactions" double precision NOT NULL,
	"avg_generations" double precision NOT NULL,
	"avg_acceptances" double precision NOT NULL,
	"avg_loc_added" double precision NOT NULL,
	"avg_loc_deleted" double precision NOT NULL,
	"avg_pr_created" double precision NOT NULL,
	"avg_pr_reviewed" double precision NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adoption_phase_daily_date_phase_number_pk" PRIMARY KEY("date","phase_number")
);
--> statement-breakpoint
CREATE TABLE "billing_daily" (
	"date" date NOT NULL,
	"login" varchar(100) NOT NULL,
	"sku" varchar(40) NOT NULL,
	"quantity_nano" bigint NOT NULL,
	"gross_nano" bigint NOT NULL,
	"discount_nano" bigint NOT NULL,
	"net_nano" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_daily_date_login_sku_pk" PRIMARY KEY("date","login","sku")
);
--> statement-breakpoint
CREATE TABLE "copilot_seats" (
	"login" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"plan" "plan" NOT NULL,
	"editor" varchar(50),
	"language" varchar(50),
	"last_activity_at" timestamp with time zone,
	"premium_requests_28d" integer,
	"acceptance_rate" smallint,
	"used_agent" boolean,
	"used_chat" boolean,
	"top_model" varchar(60),
	"team" varchar(120),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_users" (
	"login" varchar(100) PRIMARY KEY NOT NULL,
	"saml_name_id" varchar(40),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jira_people" (
	"saml_name_id" varchar(40) PRIMARY KEY NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"department" varchar(200),
	"b1_manager" varchar(200),
	"b2_manager" varchar(200),
	"jira_user_id" varchar(40),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_daily" (
	"date" date NOT NULL,
	"model" varchar(60) NOT NULL,
	"generations" integer NOT NULL,
	"acceptances" integer NOT NULL,
	"loc_added" integer NOT NULL,
	"loc_deleted" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_daily_date_model_pk" PRIMARY KEY("date","model")
);
--> statement-breakpoint
CREATE TABLE "model_spend_daily" (
	"date" date NOT NULL,
	"login" varchar(100) NOT NULL,
	"model" varchar(80) NOT NULL,
	"credits_nano" bigint NOT NULL,
	"gross_nano" bigint NOT NULL,
	"discount_nano" bigint NOT NULL,
	"net_nano" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_spend_daily_date_login_model_pk" PRIMARY KEY("date","login","model")
);
--> statement-breakpoint
CREATE TABLE "org_daily" (
	"date" date PRIMARY KEY NOT NULL,
	"daily_active_users" integer NOT NULL,
	"weekly_active_users" integer NOT NULL,
	"monthly_active_users" integer NOT NULL,
	"interactions" integer NOT NULL,
	"generations" integer NOT NULL,
	"acceptances" integer NOT NULL,
	"loc_added" integer NOT NULL,
	"loc_deleted" integer NOT NULL,
	"loc_suggested_add" integer DEFAULT 0 NOT NULL,
	"loc_suggested_delete" integer DEFAULT 0 NOT NULL,
	"chat_mau" integer DEFAULT 0 NOT NULL,
	"agent_mau" integer DEFAULT 0 NOT NULL,
	"code_review_dau" integer DEFAULT 0 NOT NULL,
	"code_review_wau" integer DEFAULT 0 NOT NULL,
	"code_review_mau" integer DEFAULT 0 NOT NULL,
	"code_review_passive_mau" integer DEFAULT 0 NOT NULL,
	"cloud_agent_dau" integer DEFAULT 0 NOT NULL,
	"cloud_agent_wau" integer DEFAULT 0 NOT NULL,
	"cloud_agent_mau" integer DEFAULT 0 NOT NULL,
	"pr_created" integer DEFAULT 0 NOT NULL,
	"pr_merged" integer DEFAULT 0 NOT NULL,
	"pr_created_by_copilot" integer DEFAULT 0 NOT NULL,
	"pr_merged_created_by_copilot" integer DEFAULT 0 NOT NULL,
	"pr_reviewed_by_copilot" integer DEFAULT 0 NOT NULL,
	"pr_copilot_suggestions" integer DEFAULT 0 NOT NULL,
	"pr_copilot_applied_suggestions" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otlp_log_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"event_name" varchar(200),
	"severity" varchar(30),
	"body" text,
	"user_id" varchar(120),
	"user_email" varchar(200),
	"session_id" varchar(120),
	"service_name" varchar(120),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otlp_metric_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"metric_name" varchar(200) NOT NULL,
	"series_key" varchar(64) NOT NULL,
	"value" double precision NOT NULL,
	"raw_value" double precision,
	"time" timestamp with time zone NOT NULL,
	"start_time" timestamp with time zone,
	"user_id" varchar(120),
	"user_email" varchar(200),
	"session_id" varchar(120),
	"organization_id" varchar(120),
	"model" varchar(100),
	"type" varchar(60),
	"service_name" varchar(120),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "refresh_kind" DEFAULT 'copilot' NOT NULL,
	"status" "refresh_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"seats_synced" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "usage_breakdown_daily" (
	"date" date NOT NULL,
	"dimension" varchar(20) NOT NULL,
	"key" varchar(80) NOT NULL,
	"interactions" integer NOT NULL,
	"generations" integer NOT NULL,
	"acceptances" integer NOT NULL,
	"loc_added" integer NOT NULL,
	"loc_deleted" integer NOT NULL,
	"loc_suggested_add" integer NOT NULL,
	"loc_suggested_delete" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_breakdown_daily_date_dimension_key_pk" PRIMARY KEY("date","dimension","key")
);
--> statement-breakpoint
CREATE INDEX "otlp_log_records_time_idx" ON "otlp_log_records" USING btree ("time");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_time_idx" ON "otlp_metric_points" USING btree ("time","metric_name");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_series_idx" ON "otlp_metric_points" USING btree ("series_key","time");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_user_idx" ON "otlp_metric_points" USING btree ("user_email");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_jobs_single_flight_idx" ON "refresh_jobs" USING btree ("kind") WHERE "refresh_jobs"."status" in ('pending', 'running');