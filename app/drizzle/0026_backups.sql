-- Stage 7 (spec §6, §11): one row per monthly Google Drive backup. Additive: one new table.
CREATE TABLE "ops"."backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" text NOT NULL,
	"status" text NOT NULL,
	"drive_folder_id" text,
	"sheet_file_id" text,
	"csv_file_id" text,
	"size_bytes" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backups_month_unique" UNIQUE("month")
);
