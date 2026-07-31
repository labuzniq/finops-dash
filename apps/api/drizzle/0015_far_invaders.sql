ALTER TABLE "gateway_notification" ALTER COLUMN "spend_nano" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_notification" ADD COLUMN "source" varchar(20) DEFAULT 'budget' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_notification" ADD COLUMN "detail" jsonb;