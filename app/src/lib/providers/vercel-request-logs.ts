// Vercel's request-logs endpoint, the one the CLI's `vercel logs` reads history from (checked live on 13 Oct 2026):
//   GET https://vercel.com/api/logs/request-logs?projectId=&ownerId=&page=&startDate=<ms>&endDate=<ms>[&level=][&environment=][&deploymentId=]
// Note the host: vercel.com, not api.vercel.com. `ownerId` is the team id. Unlike the streaming runtime-logs endpoint it
// answers on Hobby, but only for a short retention (a window 2-3 days back answered 400). The endpoint is undocumented and
// may change, so every failure is a soft "couldn't read logs" and the answer is parsed defensively; a row we can't make
// sense of is skipped, never thrown on.
import { createHash } from "node:crypto";
import { z } from "zod";
import { abortPromise } from "@/lib/collector/http-check";
import type { VercelFailure } from "./vercel";

export type RuntimeLogLine = {
  rowId: string; at: Date; level: "debug" | "info" | "warning" | "error" | "fatal" | "trace"; message: string;
  requestMethod: string | null; requestPath: string | null; statusCode: number | null; source: string | null;
  // The deployment that served the request, when Vercel says (a log read isn't limited to the current deployment).
  deploymentId?: string | null;
};

type Level = RuntimeLogLine["level"];

const ENDPOINT = "https://vercel.com/api/logs/request-logs";
const DAY = 86_400_000;
const MAX_PAGES = 3;
const MAX_ROWS = 300;
const TIMEOUT_MS = 8000;

const LEVELS: readonly Level[] = ["debug", "info", "warning", "error", "fatal", "trace"];

const responseSchema = z.object({ rows: z.array(z.unknown()).catch([]), hasMoreRows: z.boolean().catch(false) });
const FORMAT_CHANGED = "Vercel's log format changed: the answer has neither rows nor hasMoreRows.";
const rowSchema = z.object({
  requestId: z.string().min(1),
  timestamp: z.string().transform((s, ctx) => {
    const t = Date.parse(s);
    if (Number.isNaN(t)) { ctx.addIssue({ code: "custom", message: "bad timestamp" }); return z.NEVER; }
    return new Date(t);
  }),
  deploymentId: z.string().nullish().catch(null),
  requestMethod: z.string().nullish().catch(null),
  requestPath: z.string().nullish().catch(null),
  statusCode: z.number().nullish().catch(null),
  logs: z.array(z.unknown()).nullish().catch(null),
  events: z.array(z.unknown()).nullish().catch(null),
});
const messageSchema = z.object({ level: z.string().nullish().catch(null), message: z.string().nullish().catch(null) });
const eventSchema = z.object({ source: z.string().nullish().catch(null) });

// What Vercel calls a level -> ours. A message with no (or an unknown) level counts as info.
function levelOf(raw: string | null | undefined): Level {
  const s = (raw ?? "").toLowerCase();
  if (s === "warn") return "warning";
  return (LEVELS as readonly string[]).includes(s) ? (s as Level) : "info";
}

// A short stable key of one message. The row id must not depend on the message's position in `logs[]`: the server may trim
// that list by level, so a read with a level filter and one without would number the same message differently.
export const messageHash = (level: string, message: string) => createHash("sha1").update(`${level}
${message}`).digest("hex").slice(0, 8);

const failure = (kind: VercelFailure["kind"], error: string, extra: Partial<VercelFailure> = {}): VercelFailure => ({ ok: false, kind, error, ...extra });

type Opts = {
  since: Date; until: Date; levels?: readonly string[]; deploymentId?: string; environment?: string; maxRows?: number;
  // Also one line per request that printed nothing (the live view). On Hobby Vercel keeps a request's log messages for only
  // about an hour, and most requests print nothing, so without this the live view is empty although requests happened.
  requests?: boolean;
  fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: Date;
};

function linesOfRow(raw: unknown, wanted: (l: Level) => boolean, requests = false): RuntimeLogLine[] {
  const p = rowSchema.safeParse(raw);
  if (!p.success) return [];
  const r = p.data;
  const base = {
    at: r.timestamp, requestMethod: r.requestMethod ?? null, requestPath: r.requestPath ?? null, statusCode: r.statusCode ?? null,
    deploymentId: r.deploymentId ?? null,
    source: (r.events ?? []).map((e) => eventSchema.safeParse(e)).find((e) => e.success && e.data.source)?.data?.source ?? null,
  };
  const out: RuntimeLogLine[] = [];
  const repeats = new Map<string, number>();
  for (const m of r.logs ?? []) {
    const msg = messageSchema.safeParse(m);
    if (!msg.success || !msg.data.message) continue;
    const level = levelOf(msg.data.level);
    const key = messageHash(level, msg.data.message);
    const n = repeats.get(key) ?? 0; // the same text twice in one request keeps two distinct ids: "#1" for the second
    repeats.set(key, n + 1);
    if (!wanted(level)) continue;
    out.push({ rowId: `${r.requestId}:${key}${n ? `#${n}` : ""}`, level, message: msg.data.message, ...base });
  }
  // A failed request with no error line of its own still deserves one: a timeout prints no message of its own, and a
  // function that logged only info before it timed out matches the error filter but yields nothing otherwise.
  if (r.statusCode != null && r.statusCode >= 500 && wanted("error") && !out.some((l) => l.level === "error" || l.level === "fatal")) {
    out.push({ rowId: `${r.requestId}:status`, level: "error", message: `${r.requestMethod ?? "GET"} ${r.requestPath ?? "/"} → ${r.statusCode}`, ...base });
  }
  if (requests && out.length === 0) {
    const status = r.statusCode ?? 0;
    const level: Level = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
    if (wanted(level)) {
      out.push({ rowId: `${r.requestId}:request`, level, message: `${r.requestMethod ?? "GET"} ${r.requestPath ?? "/"}${status > 0 ? ` → ${status}` : ""}`, ...base });
    }
  }
  return out;
}

export async function readRequestLogs(
  token: string, teamId: string, projectId: string, opts: Opts,
): Promise<{ ok: true; lines: RuntimeLogLine[]; more: boolean } | VercelFailure> {
  const now = (opts.now ?? new Date()).getTime();
  const since = Math.max(opts.since.getTime(), now - DAY); // retention is short; asking further back only earns a 400
  const until = opts.until.getTime();
  if (since >= until) return { ok: true, lines: [], more: false };
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const wantedSet = opts.levels ? new Set<string>(opts.levels) : null;
  const wanted = (l: Level) => !wantedSet || wantedSet.has(l);
  // Vercel's own levels are error / warning / info; "fatal" has no filter value there, so it rides along with error.
  const serverLevels = opts.levels ? [...new Set(opts.levels.map((l) => (l === "fatal" ? "error" : l)))] : [];
  const doFetch = opts.fetch ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("window", "TimeoutError")), opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
  const stop = abortPromise(signal);
  const abortedFailure = (): VercelFailure => ctrl.signal.aborted && !opts.signal?.aborted
    ? failure("transient", "Vercel's log history didn't answer in time.")
    : failure("transient", "Reading Vercel's log history was cancelled.");

  const lines: RuntimeLogLine[] = [];
  let more = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ projectId, ownerId: teamId, page: String(page), startDate: String(since), endDate: String(until) });
      if (opts.deploymentId) q.set("deploymentId", opts.deploymentId);
      if (opts.environment) q.set("environment", opts.environment);
      if (serverLevels.length) q.set("level", serverLevels.join(","));
      let body: unknown;
      let fail: VercelFailure | null = null;
      try {
        const res = await Promise.race([doFetch(`${ENDPOINT}?${q}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal, cache: "no-store" }), stop]);
        if (res.status === 401 || res.status === 403) fail = failure("auth", `Vercel rejected this credential (${res.status}).`, { status: res.status });
        else if (res.status === 429) {
          const retry = Number(res.headers.get("Retry-After"));
          fail = failure("transient", "Vercel says there were too many requests.", { status: 429, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 60 });
        } else if (res.status === 400) fail = failure("transient", "Vercel's log history didn't answer (400); the range may be past retention.", { status: 400 });
        else if (!res.ok) fail = failure("transient", `Vercel's log history returned an error (${res.status}).`, { status: res.status });
        else {
          try { body = await Promise.race([res.json(), stop]); } catch (e) {
            if (signal.aborted) throw e;
            fail = failure("format", "Vercel's log history answered in a format the console doesn't recognise.");
          }
        }
        if (fail) await res.body?.cancel().catch(() => undefined);
      } catch {
        fail = signal.aborted ? abortedFailure() : failure("transient", "Couldn't reach Vercel's log history.");
      }
      if (!fail) {
        const parsed = responseSchema.safeParse(body);
        const keys = parsed.success && body && typeof body === "object" ? Object.keys(body) : [];
        if (parsed.success && !keys.includes("rows") && !keys.includes("hasMoreRows")) fail = failure("transient", FORMAT_CHANGED);
        else if (!parsed.success) fail = failure("format", "Vercel's log history answered in a format the console doesn't recognise.");
        else {
          for (const raw of parsed.data.rows) lines.push(...linesOfRow(raw, wanted, opts.requests));
          more = parsed.data.hasMoreRows;
          if (!more || lines.length >= maxRows) break;
        }
      }
      if (fail) {
        if (page === 0) return fail;
        more = true; // a later page failed: keep what the earlier ones gave
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // frees any request still open; the answer is already read
  }
  lines.sort((a, b) => a.at.getTime() - b.at.getTime());
  if (lines.length > maxRows) { lines.splice(0, lines.length - maxRows); more = true; }
  // Stopped at the page cap with rows still on Vercel's side.
  return { ok: true, lines, more };
}
