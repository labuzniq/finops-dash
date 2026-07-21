ALTER TABLE "github_users" ADD COLUMN "active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill the sticky flag: any login ever seen in a billing report is active,
-- inserting a bare row when the user export never carried it.
INSERT INTO "github_users" ("login", "active")
SELECT "login", true FROM (
	SELECT "login" FROM "billing_daily"
	UNION
	SELECT "login" FROM "model_spend_daily"
) AS "report_logins"
ON CONFLICT ("login") DO UPDATE SET "active" = true;