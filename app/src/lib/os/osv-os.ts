// OS vulnerabilities: how many advisories OSV.dev lists for each installed source package. One querybatch (up to
// 1,000 queries each); only package names and versions are sent. OSV lags Ubuntu at times, so the page words these
// counts as OSV's view and links Ubuntu's tracker for the current status.

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const BATCH = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
export const OSV_TIMEOUT_MS = 30_000;
const UNREADABLE = "OSV.dev sent an answer we couldn't read.";

export type BacklogResult = { ok: true; counts: Record<string, number> } | { ok: false; error: string };

export async function backlogCounts(
  ecosystem: string, sources: { name: string; version: string }[], fetchImpl: typeof fetch = fetch,
): Promise<BacklogResult> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < sources.length; i += BATCH) {
    const chunk = sources.slice(i, i + BATCH);
    const queries = chunk.map((s) => ({ package: { name: s.name, ecosystem }, version: s.version }));
    let text: string;
    try {
      const res = await fetchImpl(OSV_BATCH_URL, {
        method: "POST", body: JSON.stringify({ queries }), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `OSV.dev answered HTTP ${res.status}.` };
      text = await res.text();
    } catch {
      return { ok: false, error: "OSV.dev didn't answer in time." };
    }
    if (text.length > MAX_BYTES) return { ok: false, error: "OSV.dev sent too large an answer." };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: UNREADABLE };
    }
    const results = (json as { results?: unknown })?.results;
    if (!Array.isArray(results) || results.length !== chunk.length) return { ok: false, error: UNREADABLE };
    results.forEach((r, k) => {
      const vulns = (r as { vulns?: unknown })?.vulns;
      const n = Array.isArray(vulns) ? vulns.length : 0;
      if (n) counts[chunk[k].name] = (counts[chunk[k].name] ?? 0) + n;
    });
  }
  return { ok: true, counts };
}
