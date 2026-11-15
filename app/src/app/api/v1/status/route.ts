import { apiError, apiJson } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { authenticateApiKey } from "@/private/auth/api-key";
import { parseInclude, selectSections } from "@/private/console/include";
import { consoleSnapshot } from "@/private/console/snapshot";
import { listWorkspaces } from "@/lib/data/workspace-db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/v1/status (read:status): the console's apps, monitors, open alerts and advisor, scrubbed (R5). `include`
// picks sections. Read-only; keyed by a console API key alone (R2).
export async function GET(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "read:status");
  if (!auth.ok) return auth.response;
  const res = await answer(req);
  recordApiCall(auth.key, "status", "status", started, res.status); // Agents / Logs count REST calls too
  return res;
}

async function answer(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const parsed = parseInclude(params.get("include"));
  if (!parsed.ok) return apiError("invalid_request", parsed.error, 400);
  try {
    // 1.8: ?workspace=<id> narrows the answer to one workspace (Settings › Workspaces lists the ids); absent, every one.
    const ws = params.get("workspace");
    if (ws !== null && !(await listWorkspaces()).some((w) => w.id === ws)) return apiError("invalid_request", "unknown workspace", 400);
    const now = new Date();
    return apiJson(selectSections(await consoleSnapshot(now, parsed.include, ws), parsed.include));
  } catch (e) {
    console.warn("status failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its data. Try again.", 502);
  }
}
