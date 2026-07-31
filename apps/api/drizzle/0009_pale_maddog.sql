ALTER TABLE "gateway_month" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_month" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_month_line" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_month" DROP CONSTRAINT "gateway_month_pkey";--> statement-breakpoint
ALTER TABLE "gateway_month_line" DROP CONSTRAINT "gateway_month_line_month_dimension_key_pk";--> statement-breakpoint
ALTER TABLE "gateway_month" ADD CONSTRAINT "gateway_month_month_revision_pk" PRIMARY KEY("month","revision");--> statement-breakpoint
ALTER TABLE "gateway_month_line" ADD CONSTRAINT "gateway_month_line_month_revision_dimension_key_pk" PRIMARY KEY("month","revision","dimension","key");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_month_current_idx" ON "gateway_month" USING btree ("month") WHERE "gateway_month"."superseded_at" is null;
