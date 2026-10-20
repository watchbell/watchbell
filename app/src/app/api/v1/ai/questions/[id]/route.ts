import { AG_PUBLIC_PREFIX } from "@/private/ai/extras";
import { apiError, apiJson } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { questionForKey } from "@/private/assist/questions-db";
import { authenticateApiKey } from "@/private/auth/api-key";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/v1/ai/questions/{id} (ai:invoke): one question this key asked with POST /api/v1/ai/questions, for 7 days.
// Anyone else's question (the owner's from AI › Ask, another key's) answers 404 like an unknown id. The answer is
// Antigravity's markdown as it wrote it (≤ 8000 characters).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "ai:invoke");
  if (!auth.ok) return auth.response;
  const res = await answer(ctx, auth.key.keyId);
  recordApiCall(auth.key, "status", "ai/questions/{id}", started, res.status); // Agents / Logs count REST calls too
  return res;
}

const notFound = () => apiError("not_found", "No question with that id was asked with this key in the last 7 days.", 404);

async function answer(ctx: { params: Promise<{ id: string }> }, keyId: string): Promise<Response> {
  const { id } = await ctx.params;
  if (!id || !UUID.test(id)) return notFound();
  try {
    const q = await questionForKey(id.toLowerCase(), keyId, new Date());
    if (!q) return notFound();
    const answered = q.status === "answered";
    return apiJson({
      id: q.id, status: q.status, question: q.question, requestedModel: q.requestedModel ? `${AG_PUBLIC_PREFIX}${q.requestedModel}` : null,
      answer: answered ? q.answer : null,
      answeredBy: answered ? { client: q.client, model: q.model } : null,
      askedAt: q.createdAt.toISOString(),
      answeredAt: answered && q.answeredAt ? q.answeredAt.toISOString() : null,
    });
  } catch (e) {
    console.warn("ai/questions/{id} failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its data. Try again.", 502);
  }
}
