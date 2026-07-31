CREATE TABLE "gateway_budget" (
	"scope" varchar(20) NOT NULL,
	"key" varchar(200) NOT NULL,
	"label" varchar(200),
	"spend_nano" bigint NOT NULL,
	"max_budget_nano" bigint,
	"soft_budget_nano" bigint,
	"budget_duration" varchar(20),
	"reset_at" timestamp with time zone,
	"tpm_limit" bigint,
	"rpm_limit" bigint,
	"blocked" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_budget_scope_key_pk" PRIMARY KEY("scope","key")
);
