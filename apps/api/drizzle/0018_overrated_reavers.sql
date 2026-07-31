CREATE TABLE "gateway_latency_daily" (
	"date" date NOT NULL,
	"model" varchar(200) NOT NULL,
	"deployment_key" varchar(300) NOT NULL,
	"seconds_per_token_nano" bigint NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_latency_daily_date_model_deployment_key_pk" PRIMARY KEY("date","model","deployment_key")
);
--> statement-breakpoint
CREATE INDEX "gateway_latency_daily_date_idx" ON "gateway_latency_daily" USING btree ("date");