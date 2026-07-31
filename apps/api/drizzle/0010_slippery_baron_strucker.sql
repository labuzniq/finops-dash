CREATE TABLE "gateway_budget_history" (
	"scope" varchar(20) NOT NULL,
	"key" varchar(200) NOT NULL,
	"date" date NOT NULL,
	"label" varchar(200),
	"spend_nano" bigint NOT NULL,
	"max_budget_nano" bigint,
	"soft_budget_nano" bigint,
	"budget_duration" varchar(20),
	"reset_at" timestamp with time zone,
	"tpm_limit" bigint,
	"rpm_limit" bigint,
	"blocked" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_budget_history_scope_key_date_pk" PRIMARY KEY("scope","key","date")
);
--> statement-breakpoint
CREATE INDEX "gateway_budget_history_date_idx" ON "gateway_budget_history" USING btree ("date");