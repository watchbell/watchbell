import { apiError, apiJson } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { authenticateApiKey } from "@/private/auth/api-key";
import { adviceFor } from "@/private/console/advice";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/v1/advice?app=<name or id> (read:status): the latest non-dismissed AI notes for one app, newest first, at
// most 5, scrubbed. The portfolio's advisor reads it; the notes are written by an agent over MCP (submit_ai_note).
export async function GET(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "read:status");
  if (!auth.ok) return auth.response;
  const res = await answer(req);
  recordApiCall(auth.key, "status", "advice", started, res.status); // Agents / Logs count REST calls too
  return res;
}

async function answer(req: Request): Promise<Response> {
  const app = new URL(req.url).searchParams.get("app")?.trim() ?? "";
  if (!app || app.length > 100) return apiError("invalid_request", "Send the app as ?app=<name or id> (up to 100 characters).", 400);
  try {
    const advice = await adviceFor(app, new Date());
    return advice ? apiJson(advice) : apiError("not_found", "No watched app with that name or id.", 404);
  } catch (e) {
    console.warn("advice failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its data. Try again.", 502);
  }
}
