import { boolean, integer, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { monitors, ops, resources } from "./schema";

// Watchbell 1.7 (docs/superpowers/specs/2026-11-13-watchbell-1-7-reports-branding-design.md): the monthly client report.
// drizzle.config.ts reads this file too; RLS, grants and value checks are in drizzle/0063_reports_lockdown.sql.

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// One report = one client. Recipients and auto-send are the owner's to change; the rest operators may edit.
export const reports = ops.table("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientName: text("client_name").notNull(),
  title: text("title"),
  lang: text("lang").$type<"id" | "en">().notNull().default("en"),
  note: text("note"),
  emailOpening: text("email_opening"),
  recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
  autoSend: boolean("auto_send").notNull().default(false),
  sender: text("sender").$type<"smtp" | "resend">(),
  ...stamps,
});

// The sites in a report, each under the name the owner typed (never a hostname).
export const reportSites = ops.table(
  "report_sites",
  {
    reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.monitorId] })],
);

// One row per report and month the automatic send has touched: claimed (in flight), sent, or failed after 3 days.
export const reportSends = ops.table(
  "report_sends",
  {
    reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    status: text("status").$type<"claimed" | "sent" | "failed">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.month] })],
);

// Deploys per app and install-zone day, written by the daily job before retention deletes old deployments, kept as
// long as the hourly rollups (spec §5). Derived data only.
export const deployDays = ops.table(
  "deploy_days",
  {
    resourceId: uuid("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    ok: integer("ok").notNull(),
    failed: integer("failed").notNull(),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.day] })],
);
