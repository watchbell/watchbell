import { abortPromise, readCapped } from "@/lib/collector/http-check";
import { timedOut } from "@/lib/security/osv";
import type { Dep } from "./lockfile";
import { type Advisory, batchBodies, isVulnId, OSV_BATCH_URL, OSV_VULN_URL, parseAdvisory, parseBatch } from "./osv";

// Stage 9 slice 5: the scan's OSV.dev calls. Free, no key. querybatch answers only advisory ids, so each id's details
// (severity, aliases, fixed versions, summary) are read once per scan, a few at a time. Every call ends by `deadline`.

const UA = "OpsConsole-Deps/1.0 (+https://watchbell.west-solutions.web.id)";
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;
export const VULN_MAX_BYTES = 1024 * 1024;
export const DETAIL_PARALLEL = 8;
export const DETAILS_MAX = 300; // advisories read per scan; more → the scan fails closed and tries again

export type OsvOpts = { fetch?: typeof fetch; deadline: number };

async function post(url: string, body: unknown, maxBytes: number, o: OsvOpts): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const ms = o.deadline - Date.now();
  if (ms < 500) return { ok: false, error: "No time left for OSV.dev" };
  const signal = AbortSignal.timeout(ms);
  return send(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body), signal }, maxBytes, signal, o);
}

async function get(url: string, maxBytes: number, o: OsvOpts) {
  const ms = o.deadline - Date.now();
  if (ms < 500) return { ok: false as const, error: "No time left for OSV.dev" };
  const signal = AbortSignal.timeout(Math.min(ms, 8_000));
  return send(url, { method: "GET", headers: { "user-agent": UA }, signal }, maxBytes, signal, o);
}

async function send(url: string, init: RequestInit, maxBytes: number, signal: AbortSignal, o: OsvOpts): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, { ...init, redirect: "error", cache: "no-store" });
  } catch (e) {
    return { ok: false, error: timedOut(e) ? "OSV.dev didn't answer in time" : "Couldn't reach OSV.dev" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: `OSV.dev answered HTTP ${res.status}` };
  }
  try {
    const { bytes, truncated } = await readCapped(res, maxBytes, abortPromise(signal));
    if (truncated) return { ok: false, error: "OSV.dev sent too large an answer" };
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (e) {
    return { ok: false, error: timedOut(e) ? "OSV.dev didn't answer in time" : "OSV.dev sent an answer we couldn't read" };
  }
}

// The advisory ids per dependency (same order as `deps`).
export async function queryBatch(deps: Dep[], o: OsvOpts): Promise<{ ok: true; ids: string[][] } | { ok: false; error: string }> {
  const ids: string[][] = [];
  for (const body of batchBodies(deps)) {
    const r = await post(OSV_BATCH_URL, body, BATCH_MAX_BYTES, o);
    if (!r.ok) return r;
    const parsed = parseBatch(r.body, body.queries.length);
    if (!parsed) return { ok: false, error: "OSV.dev sent an answer we couldn't read" };
    ids.push(...parsed);
  }
  return { ok: true, ids };
}

// Every advisory's details, or an error when any can't be read (fail closed: a partial list would resolve rows wrongly).
export async function advisories(idList: string[], o: OsvOpts): Promise<{ ok: true; map: Map<string, Advisory> } | { ok: false; error: string }> {
  const unique = [...new Set(idList)].filter(isVulnId);
  if (unique.length > DETAILS_MAX) return { ok: false, error: `Too many advisories to read in one scan (${unique.length})` };
  const map = new Map<string, Advisory>();
  let failed: string | null = null;
  for (let i = 0; i < unique.length && !failed; i += DETAIL_PARALLEL) {
    await Promise.all(unique.slice(i, i + DETAIL_PARALLEL).map(async (id) => {
      const r = await get(`${OSV_VULN_URL}${encodeURIComponent(id)}`, VULN_MAX_BYTES, o);
      const a = r.ok ? parseAdvisory(r.body) : null;
      if (a) map.set(id, a);
      else failed ??= r.ok ? "OSV.dev sent an advisory we couldn't read" : r.error;
    }));
  }
  return failed ? { ok: false, error: failed } : { ok: true, map };
}
