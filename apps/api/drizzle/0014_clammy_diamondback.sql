CREATE TABLE "gateway_deployment_health_history" (
	"id" varchar(200) NOT NULL,
	"date" date NOT NULL,
	"backend" varchar(200) NOT NULL,
	"model" varchar(200),
	"provider" varchar(60),
	"healthy" boolean NOT NULL,
	"error" text,
	"error_status" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_deployment_health_history_id_date_pk" PRIMARY KEY("id","date")
);
--> statement-breakpoint
CREATE INDEX "gateway_deployment_health_history_date_idx" ON "gateway_deployment_health_history" USING btree ("date");