import { compareDeb } from "./debver";

// OS vulnerabilities: Ubuntu's own security data (ubuntu.com/security, the vendor source the owner asked for). Per
// source package and release it lists each CVE's priority, CVSS score, status (released = fixed in a version) and the
// notices (USN) that shipped the fix. Read only for packages with an update waiting, a page of up to 20 at a time.

export type UbuntuCve = {
  cve: string; priority: string | null; cvss3: number | null; status: string | null; version: string | null; usns: string[]; summary: string;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const dot = flat.search(/\.\s/);
  return (dot > 20 ? flat.slice(0, dot + 1) : flat).slice(0, 200);
};

// null: not a CVE list (an error page, {"errors": …}), so a broken answer never reads as "no fixes".
export function parseUbuntuCves(json: unknown, source: string, codename: string): UbuntuCve[] | null {
  if (!isObj(json) || !Array.isArray(json.cves)) return null;
  const out: UbuntuCve[] = [];
  for (const c of json.cves) {
    if (!isObj(c)) continue;
    const cve = str(c.id);
    if (!cve || !/^CVE-\d{4}-\d{4,}$/.test(cve)) continue;
    const status = arr(c.packages)
      .filter((p): p is Obj => isObj(p) && p.name === source)
      .flatMap((p) => arr(p.statuses))
      .find((s): s is Obj => isObj(s) && s.release_codename === codename);
    out.push({
      cve,
      priority: str(c.priority),
      cvss3: typeof c.cvss3 === "number" && Number.isFinite(c.cvss3) ? c.cvss3 : null,
      status: status ? str(status.status) : null,
      version: status ? str(status.description) : null,
      usns: arr(c.notices_ids).map(str).filter((s): s is string => !!s && /^USN-\d+-\d+$/.test(s)),
      summary: firstSentence(str(c.ubuntu_description) ?? str(c.description) ?? ""),
    });
  }
  return out;
}

// The CVEs an update fixes: released in this release at a version newer than the installed one and not newer than
// apt's candidate (a fix only in Ubuntu Pro's ESM pocket isn't reachable without Pro, so it isn't counted).
export function fixesBetween(cves: UbuntuCve[], installed: string, candidate: string): UbuntuCve[] {
  return cves.filter((c) => c.status === "released" && c.version !== null
    && compareDeb(c.version, installed) > 0 && compareDeb(c.version, candidate) <= 0);
}

export const ubuntuCveUrl = (cve: string): string => `https://ubuntu.com/security/${cve}`;
export const usnUrl = (id: string): string | null => (/^USN-\d+-\d+$/.test(id) ? `https://ubuntu.com/security/notices/${id}` : null);
export const ubuntuPackageUrl = (source: string, codename: string): string =>
  `https://ubuntu.com/security/cves?package=${encodeURIComponent(source)}&version=${encodeURIComponent(codename)}`;
export const kernelNoticesUrl = (codename: string): string =>
  `https://ubuntu.com/security/notices?release=${encodeURIComponent(codename)}&details=linux`;

const PAGE = 20; // the API's maximum
const MAX_PAGES = 10;
const MAX_BYTES = 2 * 1024 * 1024;
export const UBUNTU_TIMEOUT_MS = 15_000;
const UNREADABLE = "Ubuntu's security API sent an answer we couldn't read.";

export type FixesResult = { ok: true; fixes: UbuntuCve[] } | { ok: false; error: string; fixes?: UbuntuCve[] };

// Released CVEs only, newest published first, until a short page. Published order isn't fix order (Ubuntu fixes old
// CVEs later too), so it never stops early on versions (review I4); more than MAX_PAGES pages is an incomplete answer.
const unique = (fixes: UbuntuCve[]): UbuntuCve[] => {
  const seen = new Set<string>();
  return fixes.filter((f) => (seen.has(f.cve) ? false : (seen.add(f.cve), true)));
};

export async function ubuntuFixes(
  source: string, codename: string, installed: string, candidate: string, fetchImpl: typeof fetch = fetch,
): Promise<FixesResult> {
  const fixes: UbuntuCve[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://ubuntu.com/security/cves.json?package=${encodeURIComponent(source)}&version=${encodeURIComponent(codename)}&status=released&limit=${PAGE}&offset=${page * PAGE}&order=newest`;
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "Watchbell (self-hosted)" }, signal: AbortSignal.timeout(UBUNTU_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, error: `Ubuntu's security API answered HTTP ${res.status}.` };
      text = await res.text(); // a body cut off by the timeout rejects here (review M1)
    } catch {
      return { ok: false, error: "Ubuntu's security API didn't answer in time." };
    }
    if (text.length > MAX_BYTES) return { ok: false, error: "Ubuntu's security API sent too large an answer." };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: UNREADABLE };
    }
    const cves = parseUbuntuCves(json, source, codename);
    if (cves === null) return { ok: false, error: UNREADABLE };
    fixes.push(...fixesBetween(cves, installed, candidate));
    if (cves.length < PAGE) return { ok: true, fixes: unique(fixes) };
  }
  return { ok: false, error: `Ubuntu lists more fixed CVEs for this package than Watchbell reads (${MAX_PAGES * PAGE}); see Ubuntu's page.`, fixes: unique(fixes) };
}
