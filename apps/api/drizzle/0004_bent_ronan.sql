CREATE TYPE "import_log_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "import_slot" AS ENUM('model', 'cost', 'users');--> statement-breakpoint
CREATE TABLE "import_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"slot" "import_slot" NOT NULL,
	"filename" varchar(255) NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"status" "import_log_status" NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
