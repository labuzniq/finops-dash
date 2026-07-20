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
ALTER TABLE "copilot_seats" ADD COLUMN "team" varchar(120);--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "loc_suggested_add" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "loc_suggested_delete" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "chat_mau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "agent_mau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "code_review_dau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "code_review_wau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "code_review_mau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "code_review_passive_mau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "cloud_agent_dau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "cloud_agent_wau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "cloud_agent_mau" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_created" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_merged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_created_by_copilot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_merged_created_by_copilot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_reviewed_by_copilot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_copilot_suggestions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_daily" ADD COLUMN "pr_copilot_applied_suggestions" integer DEFAULT 0 NOT NULL;