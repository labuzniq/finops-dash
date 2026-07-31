CREATE TABLE "gateway_exception_daily" (
	"date" date NOT NULL,
	"model" varchar(200) NOT NULL,
	"deployment" varchar(400) NOT NULL,
	"exception_type" varchar(200) NOT NULL,
	"count" bigint NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_exception_daily_date_model_deployment_exception_type_pk" PRIMARY KEY("date","model","deployment","exception_type")
);
--> statement-breakpoint
CREATE TABLE "gateway_exception_sweep" (
	"date" date PRIMARY KEY NOT NULL,
	"models" integer NOT NULL,
	"deployments" integer NOT NULL,
	"exceptions" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gateway_exception_daily_date_idx" ON "gateway_exception_daily" USING btree ("date");