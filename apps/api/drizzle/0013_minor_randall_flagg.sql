CREATE TABLE "gateway_deployment_health" (
	"id" varchar(200) PRIMARY KEY NOT NULL,
	"backend" varchar(200) NOT NULL,
	"model" varchar(200),
	"provider" varchar(60),
	"api_base" varchar(300),
	"healthy" boolean NOT NULL,
	"error" text,
	"error_status" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
