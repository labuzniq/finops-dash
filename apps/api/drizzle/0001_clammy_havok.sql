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
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_seats" ADD COLUMN "used_agent" boolean;--> statement-breakpoint
ALTER TABLE "copilot_seats" ADD COLUMN "used_chat" boolean;--> statement-breakpoint
ALTER TABLE "copilot_seats" ADD COLUMN "top_model" varchar(60);