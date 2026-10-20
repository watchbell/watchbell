import { findMember, getSessionUser } from "@/lib/auth";
import { lastCollectorRunAt } from "@/lib/collector/last-run";
import { demoRouteRefused } from "@/lib/demo/simulate";

// For the sidebar footer, which outlives page navigations. Console members only (the proxy also requires a session).
export async function GET() {
  const refused = demoRouteRefused(); // the demo has no collector, and its sidebar doesn't poll
  if (refused) return refused;
  const session = await getSessionUser();
  if (!session || !(await findMember(session.userId))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const at = await lastCollectorRunAt();
  return Response.json({ lastRunAt: at?.toISOString() ?? null }, { headers: { "Cache-Control": "no-store" } });
}
