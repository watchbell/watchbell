import { apiError } from "@/private/api/respond";
import { recordApiCall } from "@/private/ai/usage";
import { authenticateApiKey } from "@/private/auth/api-key";
import { metricsMemo } from "@/private/console/metrics-read";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/v1/metrics (read:status, 1.8.5): the monitors and open alerts in the Prometheus text format, for a
// Prometheus or Grafana Cloud scrape with the key as a bearer token. Same scrubbed data as /api/v1/status; read at most
// once a minute per instance (private/console/metrics-read.ts).
export async function GET(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "read:status");
  if (!auth.ok) return auth.response;
  const res = await answer();
  // Final review 1.8.5 M1: a scrape every 15 s would write ~5,800 usage rows a day, so only a failed one is recorded.
  if (res.status !== 200) recordApiCall(auth.key, "status", "metrics", started, res.status);
  return res;
}

async function answer(): Promise<Response> {
  try {
    return new Response(await metricsMemo.get(), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "private, no-store" },
    });
  } catch (e) {
    console.warn("metrics failed:", e instanceof Error ? e.name : "error");
    return apiError("upstream_error", "The console couldn't read its data. Try again.", 502);
  }
}
