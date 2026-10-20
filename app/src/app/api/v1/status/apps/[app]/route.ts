import { apiError, apiJson } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { authenticateApiKey } from "@/private/auth/api-key";
import { appDetail } from "@/private/console/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/v1/status/apps/{app} (read:status): one app (name or console id) with its Why problems and monitors.
export async function GET(req: Request, ctx: { params: Promise<{ app: string }> }): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "read:status");
  if (!auth.ok) return auth.response;
  const res = await answer(req, ctx);
  recordApiCall(auth.key, "status", "status/apps", started, res.status); // Agents / Logs count REST calls too
  return res;
}

async function answer(req: Request, ctx: { params: Promise<{ app: string }> }): Promise<Response> {
  const { app } = await ctx.params;
  if (!app || app.length > 100) return apiError("not_found", "No watched app with that name or id.", 404);
  try {
    const detail = await appDetail(app, new Date());
    return detail ? apiJson(detail) : apiError("not_found", "No watched app with that name or id.", 404);
  } catch (e) {
    console.warn("status/app failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its data. Try again.", 502);
  }
}
