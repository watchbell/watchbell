// Vercel Web Analytics, read-only (checked live on 13 Oct 2026; free on Hobby up to 50k events a month, production only):
//   GET https://api.vercel.com/v1/query/web-analytics/visits/count?projectId=&teamId=&since=&until=
//     -> { data: { pageviews, visitors }, query, version }
//   GET https://api.vercel.com/v1/query/web-analytics/visits/aggregate?projectId=&teamId=&by=hour&since=&until=
//     -> { data: [{ timestamp: ISO string, pageviews?, visitors?, ... }], query, version }
// `since` and `until` are ISO strings. A project without Web Analytics answers 400 "Web Analytics is not enabled for this
// project", which is an answer ({ enabled: false }), not a failure. The count call gives the total and the unique
// visitors for the whole window (summing hourly visitors would count a returning visitor once per hour); the aggregate
// call gives the hourly series. Both are sent together. Answers are parsed defensively; a shape we don't know is a
// format failure, never a throw.
import { z } from "zod";
import { abortPromise } from "@/lib/collector/http-check";
import type { VercelFailure } from "./vercel";

export type PageViews =
  | { ok: true; enabled: false }
  // visitors is null when the count call's answer wasn't in a shape we know: the total is then the sum of the hours.
  | { ok: true; enabled: true; total: number; visitors: number | null; hourly: { at: Date; views: number }[] };

const BASE = "https://api.vercel.com/v1/query/web-analytics/visits";
const HOUR = 3_600_000;
const TIMEOUT_MS = 8000;
const NOT_ENABLED = /not enabled/i;

const failure = (kind: VercelFailure["kind"], error: string, extra: Partial<VercelFailure> = {}): VercelFailure => ({ ok: false, kind, error, ...extra });
const FORMAT = "Vercel Web Analytics answered in a format the console doesn't recognise.";

const countSchema = z.object({ data: z.object({ pageviews: z.number().finite().nonnegative(), visitors: z.number().finite().nonnegative() }) });
const aggregateSchema = z.object({ data: z.array(z.unknown()) });
const rowSchema = z.object({
  timestamp: z.string().transform((s, ctx) => {
    const t = Date.parse(s);
    if (Number.isNaN(t)) { ctx.addIssue({ code: "custom", message: "bad timestamp" }); return z.NEVER; }
    return t;
  }),
  pageviews: z.number().finite().nonnegative().nullish().catch(null),
});

type Called = { kind: "body"; body: unknown } | { kind: "off" } | { kind: "fail"; fail: VercelFailure };

type Opts = { since: Date; until: Date; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };

export async function readPageViews(token: string, teamId: string, projectId: string, opts: Opts): Promise<PageViews | VercelFailure> {
  const since = opts.since.toISOString();
  const until = opts.until.toISOString();
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("window", "TimeoutError")), opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
  const stop = abortPromise(signal);
  const abortedFailure = (): VercelFailure => ctrl.signal.aborted && !opts.signal?.aborted
    ? failure("transient", "Vercel Web Analytics didn't answer in time.")
    : failure("transient", "Reading Vercel Web Analytics was cancelled.");

  async function call(path: string, extra: Record<string, string>): Promise<Called> {
    const q = new URLSearchParams({ projectId, teamId, ...extra, since, until });
    try {
      const res = await Promise.race([doFetch(`${BASE}/${path}?${q}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal, cache: "no-store" }), stop]);
      let fail: VercelFailure | null = null;
      let off = false;
      if (res.status === 401 || res.status === 403) fail = failure("auth", `Vercel rejected this credential (${res.status}).`, { status: res.status });
      else if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After"));
        fail = failure("transient", "Vercel says there were too many requests.", { status: 429, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 60 });
      } else if (res.status === 400) {
        const text = await Promise.race([res.text(), stop]).catch(() => "");
        if (NOT_ENABLED.test(text)) off = true;
        else fail = failure("transient", "Vercel Web Analytics rejected the request (400).", { status: 400 });
      } else if (!res.ok) fail = failure("transient", `Vercel Web Analytics returned an error (${res.status}).`, { status: res.status });
      if (off) return { kind: "off" };
      if (fail) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "fail", fail };
      }
      try {
        return { kind: "body", body: await Promise.race([res.json(), stop]) };
      } catch (e) {
        if (signal.aborted) throw e;
        return { kind: "fail", fail: failure("format", FORMAT) };
      }
    } catch {
      return { kind: "fail", fail: signal.aborted ? abortedFailure() : failure("transient", "Couldn't reach Vercel Web Analytics.") };
    }
  }

  try {
    const [count, series] = await Promise.all([call("count", {}), call("aggregate", { by: "hour" })]);
    // "Not enabled" from either call is a definite answer, whatever the other call did.
    if (count.kind === "off" || series.kind === "off") return { ok: true, enabled: false };
    // Auth beats the rest: it tells the owner what to fix.
    const fails = [count, series].flatMap((c) => (c.kind === "fail" ? [c.fail] : []));
    const auth = fails.find((f) => f.kind === "auth");
    if (auth) return auth;
    const a = series.kind === "body" ? aggregateSchema.safeParse(series.body) : null;
    // The hourly series is the one we can't do without. A transient failure of either call is a failure (try again later).
    const seriesFail = series.kind === "fail" ? series.fail : !a?.success ? failure("format", FORMAT) : null;
    const transient = fails.find((f) => f.kind === "transient");
    if (transient) return transient;
    if (seriesFail) return seriesFail;
    if (!a?.success) return failure("format", FORMAT);

    // The count call's success shape was never seen live (only its 400). When its answer isn't the shape we expect but the
    // hourly series parsed, the total is the sum of the hours and the visitors are unknown (null), not a failed read.
    const c = count.kind === "body" ? countSchema.safeParse(count.body) : null;
    const rows = a.data.data.flatMap((raw) => { const r = rowSchema.safeParse(raw); return r.success ? [r.data] : []; });
    // Rows are there but none carries a page-view count: the field was renamed, not "no traffic".
    if (rows.length > 0 && rows.every((r) => r.pageviews == null)) return failure("format", FORMAT);
    const byHour = new Map<number, number>();
    for (const r of rows) {
      const hour = Math.floor(r.timestamp / HOUR) * HOUR;
      byHour.set(hour, (byHour.get(hour) ?? 0) + (r.pageviews ?? 0));
    }
    const hourly = [...byHour].sort((x, y) => x[0] - y[0]).slice(-24).map(([t, views]) => ({ at: new Date(t), views }));
    if (c?.success) return { ok: true, enabled: true, total: c.data.data.pageviews, visitors: c.data.data.visitors, hourly };
    return { ok: true, enabled: true, total: hourly.reduce((s, h) => s + h.views, 0), visitors: null, hourly };
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // frees any request still open; the answers are already read
  }
}
