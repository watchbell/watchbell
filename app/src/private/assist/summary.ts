import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { ports } from "./ports";
import { summaryPrompt } from "./prompts";
import { adviceHash, decide, SUMMARY_KEY, SUMMARY_TEXT_MAX, type StoredSummary, storedSummarySchema } from "./summary-logic";

export async function readSummary(): Promise<StoredSummary | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, SUMMARY_KEY)).limit(1);
  const parsed = storedSummarySchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export type RefreshResult = { status: "stored"; summary: StoredSummary } | { status: "no-provider" | "unchanged" | "empty" };

// The daily step (after the core advisor step) and Regenerate (force). Skipped when no provider is connected, when
// there is nothing to summarise, or when the list did not change since the stored summary (unless forced).
export async function refreshSummary(now: Date, opts: { force: boolean }): Promise<RefreshResult> {
  if (!(await ports.provider())) return { status: "no-provider" };
  const recs = await ports.advice(now);
  const why = decide(recs, await readSummary(), opts.force);
  if (why === "skip-empty") return { status: "empty" };
  if (why === "skip-unchanged") return { status: "unchanged" };
  const r = await ports.complete(summaryPrompt(recs), { purpose: "summary", maxTokens: 400 });
  const text = r.text.trim().slice(0, SUMMARY_TEXT_MAX);
  if (!text) throw new Error("The model returned no text.");
  const summary: StoredSummary = { text, model: r.model.slice(0, 200), at: now.toISOString(), count: recs.length, hash: adviceHash(recs) };
  await db().insert(settings).values({ key: SUMMARY_KEY, value: summary })
    .onConflictDoUpdate({ target: settings.key, set: { value: summary, updatedAt: now } });
  return { status: "stored", summary };
}
