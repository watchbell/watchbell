import { z } from "zod";

// What the collector keeps in ops.snapshots.data for each database kind. Tasks merge their own fields (`data || patch`),
// so every field is optional. Dates are ISO strings (jsonb). Pages read through readData(), which never throws.
const iso = z.string().nullable().optional();
const num = z.number().nullable().optional();
const text = z.string().nullable().optional();

export const supabaseData = z.object({
  status: z.string().optional(), region: text, pgVersion: text, orgSlug: text,
  freeOrg: z.boolean().nullable().optional(),        // null: the org plan couldn't be read (D3)
  pausedBeforeSeen: z.boolean().optional(),           // INACTIVE on the first sight (D4)
  lastGoodState: z.string().optional(),               // D6
  lastTrafficAt: iso, trafficAt: iso, trafficError: text,
  health: z.array(z.object({ name: z.string(), status: z.string() })).nullable().optional(), healthAt: iso, healthError: text,
  sizeBytes: num, sizeAt: iso, sizeError: text,
});
export type SupabaseData = z.infer<typeof supabaseData>;

export const neonEndpoint = z.object({
  id: z.string(), branchId: z.string(), state: z.string(), pendingState: z.string().nullable(), disabled: z.boolean(),
  minCu: z.number(), maxCu: z.number(), lastActive: z.string().nullable(),
});
export const neonBranch = z.object({ id: z.string(), name: z.string(), isDefault: z.boolean(), logicalSize: z.number().nullable() });
export const neonData = z.object({
  region: text, pgVersion: z.number().nullable().optional(), orgId: text,
  computeSeconds: num, transferBytes: num, periodStart: iso, periodEnd: iso,
  activeSeconds: num, // Stage 12: active_time_seconds this period (wall-clock time a compute was up)
  endpoints: z.array(neonEndpoint).optional(), branches: z.array(neonBranch).optional(),
  lastGoodState: z.string().optional(),
});
export type NeonData = z.infer<typeof neonData>;

export const firebaseData = z.object({
  displayName: text, latencyMs: num, pingError: text, pingReason: text, pingKind: text,
  reads: num, writes: num, deletes: num, opsAt: iso, opsError: text,
  authUsers: num, authAt: iso, authError: text,
  lastGoodState: z.string().optional(),
});
export type FirebaseData = z.infer<typeof firebaseData>;

// Stage 8. Turso: per database plus its organization's month (the free limits are org-wide). Hourly.
export const tursoData = z.object({
  org: text, group: text, primaryRegion: text, plan: text,
  blockReads: z.boolean().optional(), blockWrites: z.boolean().optional(),
  rowsRead: num, rowsWritten: num, storageBytes: num,
  orgRowsRead: num, orgRowsWritten: num, orgStorageBytes: num, orgDatabases: num, usageAt: iso, usageError: text,
  lastGoodState: z.string().optional(),
});
export type TursoData = z.infer<typeof tursoData>;

// Upstash Redis: per database (the free limits are per database). Hourly.
export const upstashData = z.object({
  region: text, status: text, type: text,
  dailyCommands: num, monthlyRequests: num, storageBytes: num, monthlyBandwidthBytes: num, statsAt: iso, statsError: text,
  lastGoodState: z.string().optional(),
});
export type UpstashData = z.infer<typeof upstashData>;

// Cloudflare D1: per database plus its account's UTC day (the row quotas and the 5 GB are account-wide). Hourly.
// usageDay is the UTC date the rows were counted for; a count from another day says nothing about today.
export const d1Data = z.object({
  accountId: text, createdAt: iso, sizeBytes: num, numTables: num, readReplication: text, detailsAt: iso, detailsError: text,
  rowsRead: num, rowsWritten: num, readQueries: num, writeQueries: num,
  accountRowsRead: num, accountRowsWritten: num, accountSizeBytes: num, accountDatabases: num,
  usageDay: text, usageAt: iso, usageError: text,
  lastGoodState: z.string().optional(),
});
export type D1Data = z.infer<typeof d1Data>;

// Field by field, so one bad field doesn't hide the rest.
export function readData<T extends z.ZodRawShape>(schema: z.ZodObject<T>, raw: unknown): z.infer<z.ZodObject<T>> {
  if (!raw || typeof raw !== "object") return {} as z.infer<z.ZodObject<T>>;
  const out: Record<string, unknown> = {};
  for (const [k, field] of Object.entries(schema.shape)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const p = (field as z.ZodType).safeParse(v);
    if (p.success) out[k] = p.data;
  }
  return out as z.infer<z.ZodObject<T>>;
}
