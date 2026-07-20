CREATE TYPE "plan" AS ENUM('Business', 'Enterprise');--> statement-breakpoint
CREATE TYPE "refresh_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "copilot_seats" (
	"login" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"plan" "plan" NOT NULL,
	"editor" varchar(50),
	"language" varchar(50),
	"last_activity_at" timestamp with time zone,
	"premium_requests_28d" integer,
	"acceptance_rate" smallint,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "refresh_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"seats_synced" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "spend_daily" (
	"date" date PRIMARY KEY NOT NULL,
	"license_cents" integer NOT NULL,
	"premium_overage_cents" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
