CREATE TABLE "gateway_model" (
	"model" varchar(200) PRIMARY KEY NOT NULL,
	"backend" varchar(200),
	"provider" varchar(60),
	"mode" varchar(40),
	"input_per_million_nano" bigint,
	"output_per_million_nano" bigint,
	"cache_read_per_million_nano" bigint,
	"cache_write_per_million_nano" bigint,
	"max_input_tokens" bigint,
	"max_output_tokens" bigint,
	"deployments" integer DEFAULT 1 NOT NULL,
	"price_varies" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
