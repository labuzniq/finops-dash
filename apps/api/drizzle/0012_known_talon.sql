CREATE TABLE "gateway_notification" (
	"fingerprint" varchar(260) PRIMARY KEY NOT NULL,
	"kind" varchar(40) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"key" varchar(200) NOT NULL,
	"label" varchar(200),
	"state" varchar(20) NOT NULL,
	"spend_nano" bigint NOT NULL,
	"max_budget_nano" bigint,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"delivery_error" text
);
--> statement-breakpoint
CREATE INDEX "gateway_notification_cleared_idx" ON "gateway_notification" USING btree ("cleared_at","last_seen_at");