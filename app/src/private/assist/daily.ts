import "server-only";
import { refreshSummary } from "./summary";

// Daily steps (registered in the T6 block of the registry; a failing step only adds to /api/daily's errors).
// advisor-summary runs after the core advisor step; it skips by itself (no provider, nothing changed, nothing to say).
export async function advisorSummaryStep(now: Date): Promise<void> {
  await refreshSummary(now, { force: false });
}
// Retention of ai_questions / ai_notes is ONE step: `ai-notes-retention` (pruneAiNotes in @/private/mcp/notes-db).
