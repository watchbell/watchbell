import { createHash } from "node:crypto";
import { z } from "zod";
import type { SnapshotRec } from "@/private/assist/prompts";

// The AI summary of the Recommendations card, stored in ops.settings "advisor.ai_summary". Pure parts.
export const SUMMARY_KEY = "advisor.ai_summary";
export const SUMMARY_TEXT_MAX = 1200;

export const storedSummarySchema = z.object({
  text: z.string().min(1).max(SUMMARY_TEXT_MAX), model: z.string().max(200), at: z.string(), count: z.number().int().min(0), hash: z.string().length(64),
});
export type StoredSummary = z.infer<typeof storedSummarySchema>;

// Same recommendations (title, app, severity, in any order) = same hash, so an unchanged list is not summarised again.
export function adviceHash(recs: SnapshotRec[]): string {
  const rows = recs.map((r) => `${r.severity}\u0000${r.app}\u0000${r.title}`).sort();
  return createHash("sha256").update(rows.join("\u0001")).digest("hex");
}

export type SummaryDecision = "run" | "skip-unchanged" | "skip-empty";

export function decide(recs: SnapshotRec[], stored: StoredSummary | null, force: boolean): SummaryDecision {
  if (!recs.length) return "skip-empty";
  if (!force && stored && stored.hash === adviceHash(recs)) return "skip-unchanged";
  return "run";
}
