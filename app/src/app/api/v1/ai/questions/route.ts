import { AG_PUBLIC_PREFIX } from "@/private/ai/extras";
import { apiError, apiJson } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { chooseAskPath } from "@/private/assist/ask-path";
import { answerWithProvider, loadAskContext, WATCHPOST_CLIENT } from "@/private/assist/provider-answer";
import { checkQuestion } from "@/private/assist/question-input";
import { enqueue, questionForKey, storeAnswered } from "@/private/assist/questions-db";
import { authenticateApiKey } from "@/private/auth/api-key";

// POST /api/v1/ai/questions (ai:invoke): ask from a script (owner 13 Oct: PowerShell, curl). Same rules as AI › Ask
// (owner 14 Oct): kind "general", 1–2000 characters, never a key or token. Optional "model" from GET /api/v1/ai/models:
// left out = the default provider's default model; a provider model id ("test/prrojects") = that model. Both are
// answered in this request: 201 with the answer, stored answered (GET pollUrl reads it back). An "ag/<id>" model goes
// to Antigravity's inbox (only while Antigravity is connected and that model is on): 202 pending, poll pollUrl.
// created_by is the key's id, so that key (and only that key) can read the question back. A provider error stores
// nothing. Request-time by nature (POST, API key).
export const maxDuration = 60;

// A 2000-character question is at most ~12 KB as escaped JSON; anything far beyond is not a question.
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "ai:invoke");
  if (!auth.ok) return auth.response;
  const res = await answer(req, auth.key.keyId);
  recordApiCall(auth.key, "status", "ai/questions", started, res.status); // Agents / Logs count REST calls too
  return res;
}

async function readQuestion(req: Request): Promise<{ ok: true; value: unknown; model: unknown } | { ok: false; res: Response }> {
  const bad = (m: string, status = 400) => ({ ok: false as const, res: apiError("invalid_request", m, status) });
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return bad("The request body is larger than 32 KB.", 413);
  const text = await req.text().catch(() => null);
  if (text === null || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return bad("The request body is larger than 32 KB.", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send JSON: {"question": "..."}.');
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad('Send JSON: {"question": "..."}.');
  return { ok: true, value: (body as Record<string, unknown>).question, model: (body as Record<string, unknown>).model };
}

async function answer(req: Request, keyId: string): Promise<Response> {
  const read = await readQuestion(req);
  if (!read.ok) return read.res;
  const checked = checkQuestion(read.value);
  if (!checked.ok) return apiError("invalid_request", checked.error, 400);
  if (read.model !== undefined && read.model !== null && typeof read.model !== "string") return apiError("invalid_request", "That model isn't available. See GET /api/v1/ai/models.", 400);
  const now = new Date();
  const origin = new URL(req.url).origin;
  let path;
  try {
    path = chooseAskPath(read.model as string | null | undefined, await loadAskContext(now));
  } catch (e) {
    console.warn("ai/questions failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its AI settings. Try again.", 502);
  }
  if (path.via === "none") {
    const notConnected = path.error.startsWith("No AI provider");
    return apiError(notConnected ? "provider_not_connected" : "invalid_request", notConnected ? path.error : "That model isn't available. See GET /api/v1/ai/models.", notConnected ? 503 : 400);
  }
  if (path.via === "provider") {
    let r;
    try {
      r = await answerWithProvider(checked.question, { model: path.model, now });
    } catch (e) {
      // The gateway's curated message (no keys, no upstream bodies); nothing is stored.
      if (e instanceof Error && e.name === "GatewayError") {
        const g = e as Error & { type?: string; status?: number };
        return apiError((g.type ?? "upstream_error") as Parameters<typeof apiError>[0], e.message.slice(0, 300), typeof g.status === "number" && g.status >= 400 ? g.status : 502);
      }
      console.warn("ai/questions provider failed:", e instanceof Error ? e.name : "error");
      return apiError("upstream_error", "The AI provider couldn't answer. Try again.", 502);
    }
    try {
      const answeredAt = new Date();
      const stored = await storeAnswered({ kind: "general", contextId: null, question: checked.question, by: keyId, askedAt: now, answeredAt, answer: r.text, client: WATCHPOST_CLIENT, model: r.model });
      const pollUrl = `${origin}/api/v1/ai/questions/${stored.id}`;
      return apiJson({
        id: stored.id, status: "answered", answer: r.text, answeredBy: { client: WATCHPOST_CLIENT, model: r.model }, askedAt: now.toISOString(), answeredAt: answeredAt.toISOString(), pollUrl,
      }, { status: 201, headers: { Location: pollUrl } });
    } catch (e) {
      console.warn("ai/questions failed:", e instanceof Error ? e.name : "error");
      return apiError("upstream_error", "The console couldn't store the question. Try again.", 502);
    }
  }
  try {
    const model = path.model;
    const r = await enqueue({ kind: "general", contextId: null, question: checked.question, by: keyId, now, model });
    if (!r.ok) return apiError("quota_exceeded", r.error, 429);
    // Asked again while the same question waits: the waiting one, with its own time.
    const asked = r.reused ? (await questionForKey(r.id, keyId, now))?.createdAt ?? now : now;
    const pollUrl = `${origin}/api/v1/ai/questions/${r.id}`;
    return apiJson({ id: r.id, status: "pending", askedAt: asked.toISOString(), requestedModel: model ? `${AG_PUBLIC_PREFIX}${model}` : null, pollUrl }, { status: 202, headers: { Location: pollUrl } });
  } catch (e) {
    console.warn("ai/questions failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't store the question. Try again.", 502);
  }
}
