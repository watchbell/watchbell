import "server-only";
import { z } from "zod";
import { mode } from "./mode";
import { devOnlyProblems, isTurnstileTestKey } from "./dev-only";

const cloudSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SECRET_KEY: z.string().min(20),
  DATABASE_URL: z.string().startsWith("postgres"),
  OPS_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64"),
  OWNER_EMAIL: z.email(),
  SITE_URL: z.url(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(10),
});

// Self-hosted and demo runs have no Supabase, no Turnstile and (for PGlite) no connection string: those are optional
// and become "" when absent, but are still validated when someone does set them.
const optional = <T extends z.ZodType<string>>(inner: T) => z.union([z.literal(""), inner]).default("");
const localSchema = cloudSchema.extend({
  NEXT_PUBLIC_SUPABASE_URL: optional(z.url()),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optional(z.string().min(20)),
  SUPABASE_SECRET_KEY: optional(z.string().min(20)),
  DATABASE_URL: optional(z.union([z.string().startsWith("postgres"), z.string().startsWith("pglite:")])),
  OWNER_EMAIL: optional(z.email()),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(z.string().min(10)),
});

export type ServerEnv = z.infer<typeof cloudSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = (mode(source) === "cloud" ? cloudSchema : localSchema).safeParse(source);
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${keys}`);
  }
  // Stage 8 cleanup: Cloudflare's Turnstile test keys are for local development only. In a production build one would
  // switch the sign-in bot check off (with the test secret every token passes), so it is refused like a missing value.
  if (source.NODE_ENV === "production" && isTurnstileTestKey(result.data.NEXT_PUBLIC_TURNSTILE_SITE_KEY)) {
    throw new Error("Missing or invalid environment variables: NEXT_PUBLIC_TURNSTILE_SITE_KEY (a test key in production)");
  }
  // The rest is only worth a warning (a local `next start` is a production build too). Names only, never values.
  const problems = devOnlyProblems(source).filter((p) => !p.startsWith("NEXT_PUBLIC_TURNSTILE_SITE_KEY"));
  if (problems.length) console.warn(`env: ${problems.join("; ")}`);
  return result.data;
}

let cached: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
