ALTER TYPE "refresh_kind" ADD VALUE 'gateway';--> statement-breakpoint
CREATE TABLE "gateway_breakdown_daily" (
	"date" date NOT NULL,
	"dimension" varchar(20) NOT NULL,
	"key" varchar(200) NOT NULL,
	"label" varchar(200),
	"spend_nano" bigint NOT NULL,
	"requests" integer NOT NULL,
	"successful_requests" integer NOT NULL,
	"failed_requests" integer NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_breakdown_daily_date_dimension_key_pk" PRIMARY KEY("date","dimension","key")
);
--> statement-breakpoint
CREATE TABLE "gateway_daily" (
	"date" date PRIMARY KEY NOT NULL,
	"spend_nano" bigint NOT NULL,
	"requests" integer NOT NULL,
	"successful_requests" integer NOT NULL,
	"failed_requests" integer NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gateway_breakdown_dimension_idx" ON "gateway_breakdown_daily" USING btree ("dimension","date");