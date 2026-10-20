import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ops, resources } from "./schema";

// Stage 9 slice 2 (SQL console). drizzle.config.ts reads this file too; RLS, grants and value checks are in
// drizzle/0039_sql_connections_lockdown.sql. Separate from schema.ts so parallel stages don't edit the same file.

// One read-only connection string per watched Supabase or Neon database, pasted by the owner and sealed (lib/crypto,
// OPS_ENCRYPTION_KEY) like the account credentials. It is opened only to run the owner's guarded query and is never
// shown again; it can be replaced or removed. role_name (the Postgres role, not a secret) and endpoint_id (Neon's
// ep-… id, to read the compute's idle state from the snapshot) are kept in clear for the page.
export const sqlConnections = ops.table("sql_connections", {
  resourceId: uuid("resource_id").primaryKey().references(() => resources.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  dsnCiphertext: text("dsn_ciphertext").notNull(),
  dsnIv: text("dsn_iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  roleName: text("role_name").notNull(),
  endpointId: text("endpoint_id"),
  addedBy: uuid("added_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
