import { index, integer, jsonb, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MetricsLatest } from "@/lib/databases/compute-metrics";
import { ops, resources } from "./schema";

// Stage 12 (compute of Supabase projects). drizzle.config.ts reads this file too; RLS, grants and value checks are in
// drizzle/0037_supabase_compute_lockdown.sql. Separate from schema.ts so parallel stages don't edit the same file.

// One Secret API key per watched Supabase project, pasted by the owner and sealed (lib/crypto, OPS_ENCRYPTION_KEY) like
// the account credentials. It is only ever sent to that project's Metrics API and never shown again. `latest` is the
// newest scrape (values, CPU counters for the next delta, recent CPU); the last_* columns say how the last try went.
export const supabaseMetricsKeys = ops.table("supabase_metrics_keys", {
  resourceId: uuid("resource_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
  keyCiphertext: text("key_ciphertext").notNull(),
  keyIv: text("key_iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  addedBy: uuid("added_by"),
  latest: jsonb("latest").$type<MetricsLatest>(),
  lastTryAt: timestamp("last_try_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Hourly rollups per project (lib/databases/compute-metrics.ts mergeHour), kept RETENTION_DAYS (3) days.
export const supabaseMetrics = ops.table("supabase_metrics", {
  resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
  hour: timestamp("hour", { withTimezone: true }).notNull(),
  samples: integer("samples").notNull().default(0),
  cpuSamples: integer("cpu_samples").notNull().default(0),
  cpuAvg: real("cpu_avg"),
  cpuMax: real("cpu_max"),
  memAvg: real("mem_avg"),
  memMax: real("mem_max"),
  diskPct: real("disk_pct"),
  connUsed: integer("conn_used"),
  connMax: integer("conn_max"),
}, (t) => [primaryKey({ columns: [t.resourceId, t.hour] }), index("supabase_metrics_hour_idx").on(t.hour)]);
