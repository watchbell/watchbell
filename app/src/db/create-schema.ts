import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CreateInputs, CreateResult, CreateStatus, CreateType } from "@/lib/create/types";
import { ops } from "./schema";

// Stage 6 (owner 16 Oct): creating resources from the console, always through the Owner's approval
// (docs/superpowers/specs/2026-10-15-stage-6-create-resources.md). One row per request: requested → approved → running
// → done | failed, or rejected / expired (24 h). drizzle.config.ts reads this file; RLS, grants and value checks
// (types, statuses, lengths, and "no secret keys in inputs") are in drizzle/0049_create_requests_lockdown.sql.
// `inputs` never holds a secret: a Supabase project's database password is generated at approval and only returned once.
export const createRequests = ops.table("create_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").$type<CreateType>().notNull(),
  provider: text("provider").notNull(),
  accountId: uuid("account_id"), // ops.accounts row (null for Firebase: the owner's Google create grant)
  targetResourceId: uuid("target_resource_id"), // the zone or the Neon project; null for Supabase and Firebase
  targetLabel: text("target_label").notNull(), // ≤ 120: a zone or project name as the console shows it
  inputs: jsonb("inputs").$type<CreateInputs>().notNull(),
  status: text("status").$type<CreateStatus>().notNull().default("requested"),
  requestedBy: uuid("requested_by").notNull(), // members.id
  approvedBy: uuid("approved_by"), // members.id (the approver or the rejecter)
  result: jsonb("result").$type<CreateResult>(), // ids and names only
  error: text("error"), // ≤ 300, our own sentence
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("create_requests_status_created_idx").on(t.status, t.createdAt),
  index("create_requests_requested_by_created_idx").on(t.requestedBy, t.createdAt),
]);
