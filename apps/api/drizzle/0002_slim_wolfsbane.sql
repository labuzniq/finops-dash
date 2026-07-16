CREATE TABLE "otlp_log_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"event_name" varchar(200),
	"severity" varchar(30),
	"body" text,
	"user_id" varchar(120),
	"user_email" varchar(200),
	"session_id" varchar(120),
	"service_name" varchar(120),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otlp_metric_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"metric_name" varchar(200) NOT NULL,
	"series_key" varchar(64) NOT NULL,
	"value" double precision NOT NULL,
	"raw_value" double precision,
	"time" timestamp with time zone NOT NULL,
	"start_time" timestamp with time zone,
	"user_id" varchar(120),
	"user_email" varchar(200),
	"session_id" varchar(120),
	"organization_id" varchar(120),
	"model" varchar(100),
	"type" varchar(60),
	"service_name" varchar(120),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otlp_log_records_time_idx" ON "otlp_log_records" USING btree ("time");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_time_idx" ON "otlp_metric_points" USING btree ("time","metric_name");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_series_idx" ON "otlp_metric_points" USING btree ("series_key","time");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_user_idx" ON "otlp_metric_points" USING btree ("user_email");