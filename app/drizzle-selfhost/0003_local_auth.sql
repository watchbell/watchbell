CREATE TABLE "ops"."local_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"aal" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "ops"."local_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_sealed" text,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_step" bigint,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"temp_password_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."local_sessions" ADD CONSTRAINT "local_sessions_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "ops"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_sessions_token_hash" ON "ops"."local_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "local_sessions_user" ON "ops"."local_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_users_email" ON "ops"."local_users" USING btree ("email");--> statement-breakpoint
-- Value checks drizzle-kit can't express (bounds as the sign-in code in lib/local-auth uses them).
ALTER TABLE "ops"."local_users" ADD CONSTRAINT "local_users_email_check" CHECK (char_length(email) between 3 and 254 AND email = lower(email) AND email !~ '[[:space:]]');--> statement-breakpoint
ALTER TABLE "ops"."local_users" ADD CONSTRAINT "local_users_password_hash_check" CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$' AND char_length(password_hash) <= 300);--> statement-breakpoint
ALTER TABLE "ops"."local_sessions" ADD CONSTRAINT "local_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "ops"."local_sessions" ADD CONSTRAINT "local_sessions_aal_check" CHECK (aal in ('aal1', 'aal2'));--> statement-breakpoint
ALTER TABLE "ops"."local_sessions" ADD CONSTRAINT "local_sessions_user_agent_check" CHECK (user_agent is null or char_length(user_agent) <= 200);
