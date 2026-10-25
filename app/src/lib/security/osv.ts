import { abortPromise, readCapped } from "@/lib/collector/http-check";
import { sortFindings } from "./rules";
import { compareVersions } from "./semver";
import { type Finding, type Severity, SEVERITIES } from "./types";

// OSV.dev: free, no key. One read-only query per app: which advisories affect npm `next` at this version.
export const OSV_URL = "https://api.osv.dev/v1/query";
export const MAX_FINDINGS = 50;
const SUMMARY_MAX = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function severityOf(v: Obj): Severity {
  const raw = isObj(v.database_specific) ? str(v.database_specific.severity)?.toUpperCase() : undefined;
  if (raw === "MEDIUM") return "MODERATE";
  return (SEVERITIES as readonly string[]).includes(raw ?? "") ? (raw as Severity) : "UNKNOWN";
}

const isNext = (a: Obj) => isObj(a.package) && a.package.name === "next" && a.package.ecosystem === "npm";

// The lowest `fixed` among the npm `next` ranges whose [introduced, fixed) interval holds the version. A range closed
// by `last_affected` (or left open) has no fix to name.
export function fixedFor(affected: unknown, version: string): string | null {
  let best: string | null = null;
  for (const a of arr(affected)) {
    if (!isObj(a) || !isNext(a)) continue;
    for (const r of arr(a.ranges)) {
      if (!isObj(r) || (r.type !== "SEMVER" && r.type !== "ECOSYSTEM")) continue;
      let start: string | null = null;
      for (const e of arr(r.events)) {
        if (!isObj(e)) continue;
        const introduced = str(e.introduced);
        const fixed = str(e.fixed);
        if (introduced) start = introduced;
        else if (fixed && start !== null) {
          const holds = compareVersions(version, start) >= 0 && compareVersions(version, fixed) < 0;
          if (holds && (best === null || compareVersions(fixed, best) < 0)) best = fixed;
          start = null;
        } else if (str(e.last_affected) || str(e.limit)) start = null;
      }
    }
  }
  return best;
}

// The advisory list of one OSV answer page, or null when the body isn't an OSV answer at all. {} is a clean answer.
function vulnsOf(body: unknown): unknown[] | null {
  if (!isObj(body)) return null;
  if (body.vulns === undefined) return [];
  return Array.isArray(body.vulns) ? body.vulns : null;
}

// Per advisory: the GHSA id, its CVE alias, summary, severity (database_specific.severity) and fix. Worst first, ≤ 50.
// Fails closed: null for anything that isn't an OSV answer, or a non-empty list where no entry is readable, so a
// strange 200 never turns a vulnerable app into "ok".
export function parseOsv(body: unknown, version: string): Finding[] | null {
  const vulns = vulnsOf(body);
  return vulns === null ? null : parseVulns(vulns, version);
}

function parseVulns(vulns: unknown[], version: string): Finding[] | null {
  const out: Finding[] = [];
  let readable = 0;
  for (const v of vulns) {
    if (!isObj(v)) continue;
    const id = str(v.id);
    if (!id) continue;
    readable++;
    if (v.withdrawn) continue;
    out.push({
      id: id.slice(0, 64),
      cve: arr(v.aliases).map(str).find((a): a is string => !!a && /^CVE-\d{4}-\d+$/.test(a)) ?? null,
      summary: (str(v.summary) ?? "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX),
      severity: severityOf(v),
      fixed: fixedFor(v.affected, version),
    });
  }
  if (vulns.length > 0 && readable === 0) return null;
  return sortFindings(out).slice(0, MAX_FINDINGS);
}

export type OsvResult = { ok: true; findings: Finding[] } | { ok: false; error: string };

export const OSV_MAX_BYTES = 2 * 1024 * 1024;
export const OSV_MAX_PAGES = 3;
const UNREADABLE = "OSV.dev sent an answer we couldn't read";

// One read-only query (POST), following next_page_token for at most 3 pages. OSV pages at about 1,000 advisories, far
// more than npm `next` has, so a fourth page is never needed in practice; if one were, the first three are used. Each
// answer is read up to 2 MB. The timeout covers every page.
export async function queryOsv(
  version: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch; maxBytes?: number } = {},
): Promise<OsvResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? OSV_MAX_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  const stop = abortPromise(signal);
  const late = `OSV.dev didn't answer within ${waitText(timeoutMs)}`;
  const all: unknown[] = [];
  let token: string | null = null;
  for (let page = 0; page < OSV_MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(OSV_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "OpsConsole-Security/1.0 (+https://watchbell.west-solutions.web.id)" },
        body: JSON.stringify({ package: { name: "next", ecosystem: "npm" }, version, ...(token ? { page_token: token } : {}) }),
        redirect: "error",
        cache: "no-store",
        signal,
      });
    } catch (e) {
      return { ok: false, error: timedOut(e) ? late : "Couldn't reach OSV.dev" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, error: `OSV.dev answered HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      const { bytes, truncated } = await readCapped(res, maxBytes, stop);
      if (truncated) return { ok: false, error: "OSV.dev sent too large an answer" };
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return { ok: false, error: timedOut(e) ? late : UNREADABLE };
    }
    const vulns = vulnsOf(body);
    if (vulns === null) return { ok: false, error: UNREADABLE };
    all.push(...vulns);
    token = isObj(body) ? str(body.next_page_token) : null;
    if (!token) break;
  }
  const findings = parseVulns(all, version);
  return findings === null ? { ok: false, error: UNREADABLE } : { ok: true, findings };
}

export const timedOut = (e: unknown) => e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
export const waitText = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);
