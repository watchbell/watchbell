import { z } from "zod";

// Shared fetch for the stage-3 adapters (Supabase, Neon, Google). Vercel keeps its own wrapper from stage 2.
// auth: the credential itself was rejected. scope: the credential works but lacks a permission or role for this call
// (Supabase missing_permissions, any Google 403). missing: 404. transient: timeout, network, 429, 5xx. format: odd answer.
export type FailureKind = "auth" | "scope" | "missing" | "transient" | "format";
export type Failure = {
  ok: false; kind: FailureKind; error: string;
  status?: number; retryAfterS?: number; missing?: string[]; reason?: string; message?: string;
};
export type Result<T> = { ok: true; data: T } | Failure;
export type FetchOpts = { fetch?: typeof fetch; timeoutMs?: number };
// basic: HTTP Basic auth (stage 8, Upstash's Developer API: email and API key). Never logged.
type Init = { method?: "GET" | "POST"; token?: string; basic?: { user: string; pass: string }; body?: unknown; form?: URLSearchParams };

const googleError = z.object({
  error: z.object({
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.looseObject({ reason: z.string().optional() })).optional(),
  }),
});
const plainError = z.object({ message: z.string() });
const missingPermissions = z.object({ missing_permissions: z.array(z.string()).min(1) });
const oauthError = z.object({ error: z.enum(["invalid_grant", "invalid_client", "unauthorized_client"]) });

export async function callJson(name: string, url: string, init: Init, opts: FetchOpts = {}): Promise<Result<unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  else if (init.basic) headers.Authorization = `Basic ${Buffer.from(`${init.basic.user}:${init.basic.pass}`).toString("base64")}`;
  let body: string | URLSearchParams | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `${name} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Couldn't reach ${name}.` };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json };

  const g = googleError.safeParse(json);
  const reason = g.success ? (g.data.error.details?.find((d) => d.reason)?.reason ?? g.data.error.status) : undefined;
  // Google nests its message; Supabase's Management API answers { message } (e.g. the Postgres error of a query).
  const plain = g.success ? undefined : plainError.safeParse(json);
  const message = g.success ? g.data.error.message?.slice(0, 300) : plain?.success ? plain.data.message.slice(0, 600) : undefined;
  const base = { status: res.status, ...(reason ? { reason } : {}), ...(message ? { message } : {}) };

  if (res.status === 403) {
    const m = missingPermissions.safeParse(json);
    if (m.success) {
      const list = m.data.missing_permissions;
      return { ok: false, kind: "scope", ...base, missing: list, error: `Missing permission${list.length > 1 ? "s" : ""}: ${list.join(", ")}.` };
    }
    if (g.success) return { ok: false, kind: "scope", ...base, error: `${name} refused this request (${reason ?? "PERMISSION_DENIED"}).` };
  }
  if (res.status === 401 || res.status === 403 || (res.status === 400 && oauthError.safeParse(json).success)) {
    return { ok: false, kind: "auth", ...base, error: `${name} rejected this credential (${res.status}).` };
  }
  if (res.status === 404) return { ok: false, kind: "missing", ...base, error: `${name} doesn't know this resource (404).` };
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    return {
      ok: false, kind: "transient", ...base, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 60,
      error: reason === "RESOURCE_EXHAUSTED" ? `${name} says a quota is used up.` : `${name} says there were too many requests.`,
    };
  }
  return { ok: false, kind: "transient", ...base, error: `${name} returned an error (${res.status}).` };
}

export const formatFailure = (name: string, what: string): Failure =>
  ({ ok: false, kind: "format", error: `${name} answered ${what} in a format the console doesn't recognise.` });
