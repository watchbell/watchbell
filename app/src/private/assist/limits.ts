import { type Limit, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// The owner's AI quota: Ask AI, Ask Antigravity, Regenerate, Explain with AI (1.3) and the Models page's tests share it.
// 20 calls per 10 minutes per member. A plain module (not "use server") so several action files can import it.
export const AI_LIMIT: Limit = { name: "ai-assist", max: 20, windowSeconds: 600 };

// One call against the quota; the refusal sentence when it's used up, else null.
export async function overQuota(memberId: string): Promise<string | null> {
  const q = await limit(AI_LIMIT, memberId);
  return q.allowed ? null : `Too many AI requests. Try again in ${minutesText(q.retryAfter)}.`;
}

// The gateway's own errors carry curated messages (no keys, no upstream bodies). Anything else is generic.
export function safeError(e: unknown): string {
  return e instanceof Error && e.name === "GatewayError" ? e.message.slice(0, 300) : "The AI provider couldn't answer. Try again.";
}
