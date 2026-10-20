import "server-only";
import { z } from "zod";
import { mode } from "../mode";

const cloudSchema = z.object({
  COLLECTOR_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(10),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(10),
});
// Self-hosted runs use the built-in scheduler, so QStash is not needed ("" when absent, checked when set).
const selfhostSchema = cloudSchema.extend({
  QSTASH_CURRENT_SIGNING_KEY: z.union([z.literal(""), z.string().min(10)]).default(""),
  QSTASH_NEXT_SIGNING_KEY: z.union([z.literal(""), z.string().min(10)]).default(""),
});
export type CollectorEnv = z.infer<typeof cloudSchema>;

export function parseCollectorEnv(source: Record<string, string | undefined>): CollectorEnv {
  const r = (mode(source) === "selfhost" ? selfhostSchema : cloudSchema).safeParse(source);
  if (!r.success) throw new Error(`Missing or invalid scheduler settings: ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return r.data;
}

// Separate from serverEnv on purpose: a missing scheduler secret disables the three /api routes, not the console.
let warned = false;
export function collectorEnv(): CollectorEnv | null {
  try {
    return parseCollectorEnv(process.env);
  } catch (e) {
    // The message names the keys only, never their values. Once per process so a scheduler doesn't flood the log.
    if (!warned) {
      warned = true;
      console.warn(e instanceof Error ? e.message : "Missing or invalid scheduler settings");
    }
    return null;
  }
}
