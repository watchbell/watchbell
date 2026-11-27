import { boolean, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ops } from "./schema";

// Watchbell 1.8.6 (docs/superpowers/specs/2026-11-25-watchbell-1-8-6-alertmanager-design.md): the outside tools that
// may post alerts to Watchbell. drizzle.config.ts reads this file too; RLS, grants and value checks are in
// drizzle/0068_ingest_sources_lockdown.sql (self-host: drizzle-selfhost/0015_external_alert_rule.sql).

// One row per source. The token is never stored: only its sha256 (lib/heartbeat-token tokenHash) and the first 7
// characters to show in the UI. Revoking sets enabled false; setting up again makes a new row with a new token.
export const ingestSources = ops.table("ingest_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"alertmanager">().notNull(),
  name: text("name").notNull().default("Alertmanager"),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // "This month" counters: monthKey (YYYY-MM) is the month they count; a call in a new month starts them at 0.
  monthKey: text("month_key"),
  receivedMonth: integer("received_month").notNull().default(0),
  refusedMonth: integer("refused_month").notNull().default(0),
});

export type IngestSource = typeof ingestSources.$inferSelect;
