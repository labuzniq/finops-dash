CREATE TABLE "user_daily" (
	"date" date NOT NULL,
	"login" varchar(100) NOT NULL,
	"interactions" integer NOT NULL,
	"generations" integer NOT NULL,
	"acceptances" integer NOT NULL,
	"loc_added" integer NOT NULL,
	"loc_deleted" integer NOT NULL,
	"loc_suggested_add" integer NOT NULL,
	"loc_suggested_delete" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_daily_date_login_pk" PRIMARY KEY("date","login")
);
