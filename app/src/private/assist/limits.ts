import type { Limit } from "@/lib/rate-limit";

// The owner's AI quota: Ask AI, Ask Antigravity, Regenerate and the Models page's tests share it. 20 calls per 10
// minutes per member. A plain module (not "use server") so several action files can import it.
export const AI_LIMIT: Limit = { name: "ai-assist", max: 20, windowSeconds: 600 };
