import type { FetchOpts, Result } from "./http";

// Stage 12: one GET of a Supabase project's Metrics API (beta; supabase.com/docs/guides/observability/metrics).
// Basic Auth: user `service_role`, password the project's Secret API key (sb_secret_…), which the owner pastes per
// project. The key goes in the Authorization header only, never in a URL, a log line or an error text.
const NAME = "Supabase Metrics API";
// Project refs are 20 lowercase letters; anything else never reaches a URL.
export const isProjectRef = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{8,40}$/.test(v);
// A Secret API key as the dashboard shows it. Legacy service_role JWTs are not accepted: the docs ask for a secret key.
export const isSecretKey = (v: unknown): v is string => typeof v === "string" && /^sb_secret_[A-Za-z0-9_-]{8,200}$/.test(v);

export const metricsUrl = (ref: string) => `https://${ref}.supabase.co/customer/v1/privileged/metrics`;
// The answer is ~200 series (tens of kB); anything far larger is not what we asked for.
const MAX_BYTES = 4_000_000;

export async function fetchSupabaseMetrics(ref: string, secretKey: string, opts: FetchOpts = {}): Promise<Result<string>> {
  if (!isProjectRef(ref)) return { ok: false, kind: "format", error: "That isn't a Supabase project ref." };
  const timeoutMs = opts.timeoutMs ?? 8000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(metricsUrl(ref), {
      headers: { Authorization: `Basic ${Buffer.from(`service_role:${secretKey}`).toString("base64")}`, Accept: "text/plain" },
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "manual",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `${NAME} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Couldn't reach the ${NAME}.` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "auth", status: res.status, error: `Supabase rejected the metrics key (${res.status}). Replace it with a current Secret API key.` };
  }
  if (res.status === 404) return { ok: false, kind: "missing", status: 404, error: "Supabase has no metrics endpoint for this project (404)." };
  if (res.status === 429) return { ok: false, kind: "transient", status: 429, retryAfterS: 60, error: `${NAME} says there were too many requests.` };
  if (!res.ok) return { ok: false, kind: "transient", status: res.status, error: `${NAME} returned an error (${res.status}).` };
  const text = await res.text().catch(() => null);
  if (text === null || text.length > MAX_BYTES || !/^(#|[A-Za-z_:])/m.test(text)) {
    return { ok: false, kind: "format", error: `${NAME} answered in a format the console doesn't recognise.` };
  }
  return { ok: true, data: text };
}
