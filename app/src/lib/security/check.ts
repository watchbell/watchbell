import { REDIRECTED_AWAY, safeGet } from "@/lib/collector/http-check";
import { extractNextVersion, nextScriptUrls } from "./next-version";
import { queryOsv } from "./osv";
import type { SecurityRow } from "./types";

export const MAX_SCRIPTS = 12;
export const SCRIPT_MAX_BYTES = 3 * 1024 * 1024;
export const SITE_BUDGET_MS = 15_000;
export const OSV_TIMEOUT_MS = 10_000;
const AGENT = "OpsConsole-Security/1.0 (+https://watchbell.west-solutions.web.id)";

type Deps = {
  // Epoch ms the caller must finish by (the daily step's budget). Past it the app is skipped (null), tried next time.
  deadline?: number;
  lookup?: (host: string) => Promise<string[]>;
  fetch?: typeof fetch;
  now?: () => Date;
};

// One app: GET its production page, read the Next.js version from its own /_next/static scripts (at most 12, each
// capped at 3 MB, 15 s in all), then ask OSV.dev. Every site request goes through the monitors' SSRF guard (safeGet).
// A failed load, an unreadable version or a failed OSV lookup keeps the previous version and findings (status error or
// unknown, with the reason), so an outage or a changed build never hides a known vulnerability. Bodies are only
// scanned, never kept.
export async function checkNextSecurity(host: string, prev: SecurityRow | null, deps: Deps = {}): Promise<SecurityRow | null> {
  const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;
  const now = deps.now ?? (() => new Date());
  const left = (until: number) => Math.floor(Math.min(until, deadline) - Date.now());
  const siteUntil = Date.now() + SITE_BUDGET_MS;
  if (left(siteUntil) <= 0) return null;

  // Anything short of a version that was actually read keeps the previous version and findings: only a real "ok"
  // clears a known vulnerability. `error` is a failed request, `unknown` a site that answered but showed no version.
  const keep = (status: "error" | "unknown", reason: string): SecurityRow => ({
    version: prev?.version ?? null, status, findings: prev?.findings ?? [], reason, checkedAt: now(),
  });
  const get = (url: string, sameOrigin: true | "www") => safeGet(url, {
    maxBytes: SCRIPT_MAX_BYTES, timeoutMs: left(siteUntil), lookup: deps.lookup, fetch: deps.fetch, userAgent: AGENT, sameOrigin,
  });

  // The page may only redirect on the app's own host (or its www. twin): a login or SSO page elsewhere is another
  // site, often built with Next.js itself, and its version must never be stored as the app's.
  const page = await get(`https://${host}/`, "www");
  if (!page.ok && page.error === REDIRECTED_AWAY) return keep("unknown", "the site redirects to another host");
  if (!page.ok || page.status !== 200) {
    if (Date.now() >= deadline) return null;
    return keep("error", `Couldn't load the site: ${page.ok ? `HTTP ${page.status}` : page.error}`);
  }
  // Only script files are read; the HTML itself can quote Next.js code (a blog post).
  const scripts = nextScriptUrls(page.body, page.url).slice(0, MAX_SCRIPTS);
  if (scripts.length === 0) return keep("unknown", page.body.includes("/_next/") ? "version not exposed" : "not a Next.js site");

  let version: string | null = null;
  let read = 0;
  let ranOut = false;
  for (const url of scripts) {
    if (left(siteUntil) <= 0) {
      ranOut = true;
      break;
    }
    const r = await get(url, true);
    if (!r.ok || r.status !== 200) continue;
    read++;
    version = extractNextVersion(r.body);
    if (version) break;
  }
  if (!version) {
    if (Date.now() >= deadline) return null;
    if (ranOut || left(siteUntil) <= 0) return keep("error", `Reading the site's scripts took longer than ${SITE_BUDGET_MS / 1000} s`);
    return read === 0 ? keep("error", "Couldn't load the site's scripts") : keep("unknown", "version not exposed");
  }

  const osvLeft = left(Date.now() + OSV_TIMEOUT_MS);
  if (osvLeft <= 0) return null;
  const osv = await queryOsv(version, { timeoutMs: osvLeft, fetch: deps.fetch });
  if (!osv.ok) return Date.now() >= deadline ? null : keep("error", osv.error);
  return { version, status: osv.findings.length ? "vulnerable" : "ok", findings: osv.findings, reason: null, checkedAt: now() };
}

// The daily route has maxDuration 60 and runs rollups, retention and sync first. The security step gets about 35 s,
// and never runs past 55 s into the run, so the run row is always finished in time.
export const DAILY_STEP_MS = 35_000;
export const DAILY_HARD_STOP_MS = 55_000;
export function dailyDeadline(startedMs: number, nowMs: number): number {
  return Math.min(nowMs + DAILY_STEP_MS, startedMs + DAILY_HARD_STOP_MS);
}
