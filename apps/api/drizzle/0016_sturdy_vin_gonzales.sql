CREATE TABLE "gateway_slow_response_daily" (
	"date" date NOT NULL,
	"model" varchar(200) NOT NULL,
	"deployment_key" varchar(300) NOT NULL,
	"total_count" bigint NOT NULL,
	"slow_count" bigint NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_slow_response_daily_date_model_deployment_key_pk" PRIMARY KEY("date","model","deployment_key")
);
--> statement-breakpoint
CREATE INDEX "gateway_slow_response_daily_date_idx" ON "gateway_slow_response_daily" USING btree ("date");