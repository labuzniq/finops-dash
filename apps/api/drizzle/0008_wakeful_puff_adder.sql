CREATE TABLE "gateway_month" (
	"month" varchar(7) PRIMARY KEY NOT NULL,
	"month_start" date NOT NULL,
	"month_end" date NOT NULL,
	"days" integer NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_by" varchar(20) NOT NULL,
	"spend_nano" bigint NOT NULL,
	"requests" bigint NOT NULL,
	"successful_requests" bigint NOT NULL,
	"failed_requests" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_month_line" (
	"month" varchar(7) NOT NULL,
	"dimension" varchar(20) NOT NULL,
	"key" varchar(200) NOT NULL,
	"label" varchar(200),
	"spend_nano" bigint NOT NULL,
	"requests" bigint NOT NULL,
	"successful_requests" bigint NOT NULL,
	"failed_requests" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL,
	CONSTRAINT "gateway_month_line_month_dimension_key_pk" PRIMARY KEY("month","dimension","key")
);
