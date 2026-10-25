import { z } from "zod";
import { isIP } from "node:net";
import { safeGet } from "@/lib/collector/http-check";
import { urlProblem } from "@/lib/net/public-host";

// Domain expiry through RDAP (idea U1; replaces Cloudflare Registrar, which can't see the owner's domains). The
// server comes from IANA's bootstrap file; the .id registry (rdap.pandi.id) answers for web.id (checked 12 Oct 2026).
// Public data, no key, GET only. The base URL comes from IANA and the name from a Cloudflare zone, never from a user.
// Even so every request goes through the monitors' guard (collector/http-check safeGet): https, port 443, a public
// host resolved first with every address checked, and each redirect hop checked again (stage 4 review I2).

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export type Services = [string[], string[]][];
type Opts = { fetch?: typeof fetch; timeoutMs?: number; lookup?: (host: string) => Promise<string[]> };
const RDAP_AGENT = "OpsConsole-Network/1.0 (+https://watchbell.west-solutions.web.id)";
export const NOT_PUBLIC = "The registry's RDAP address isn't a public https address";
const MAX_BYTES = 512 * 1024;

const bare = (n: string) => n.toLowerCase().replace(/\.$/, "");

export function rdapBase(services: Services, name: string): string | null {
  const labels = bare(name).split(".");
  // Bootstrap entries are TLDs (sometimes longer suffixes): the longest suffix wins.
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const hit = services.find(([tlds]) => tlds.map(bare).includes(suffix));
    if (hit) return hit[1].find(publicHttps) ?? null;
  }
  return null;
}

// https, port 443, no userinfo, a public name. A registry has a name, so a bare IP (even a public one) is refused too.
function publicHttps(u: string): boolean {
  try {
    const url = new URL(u);
    return urlProblem(url) === null && !isIP(url.hostname.replace(/^[|]$/g, ""));
  } catch {
    return false;
  }
}

const domainSchema = z.object({
  objectClassName: z.literal("domain"),
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).default([]),
  entities: z.array(z.object({ roles: z.array(z.string()).default([]), vcardArray: z.unknown().optional() })).default([]),
});

function vcardName(v: unknown): string | null {
  if (!Array.isArray(v) || !Array.isArray(v[1])) return null;
  const fn = (v[1] as unknown[]).find((p) => Array.isArray(p) && p[0] === "fn") as unknown[] | undefined;
  return typeof fn?.[3] === "string" && fn[3] ? fn[3] : null;
}

export function parseRdapDomain(body: unknown): { expiresAt: string | null; registrar: string | null } | null {
  const p = domainSchema.safeParse(body);
  if (!p.success) return null;
  const exp = p.data.events.find((e) => e.eventAction === "expiration");
  const at = exp ? new Date(exp.eventDate) : null;
  const registrar = p.data.entities.find((e) => e.roles.includes("registrar"));
  return { expiresAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null, registrar: registrar ? vcardName(registrar.vcardArray) : null };
}

async function getJson(url: string, accept: string, opts: Opts): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  const r = await safeGet(url, {
    fetch: opts.fetch, lookup: opts.lookup, timeoutMs: opts.timeoutMs ?? 8000, maxBytes: MAX_BYTES, headers: { Accept: accept }, userAgent: RDAP_AGENT,
  });
  if (!r.ok) return { ok: false, error: r.error === "Blocked address" ? NOT_PUBLIC : "Couldn't reach the registry's RDAP server" };
  if (r.truncated) return { ok: false, error: "The answer was too large" };
  if (r.status !== 200) return { ok: true, status: r.status, body: null };
  try {
    return { ok: true, status: r.status, body: JSON.parse(r.body) as unknown };
  } catch {
    return { ok: false, error: "The registry answered in a format the console doesn't recognise" };
  }
}

const bootstrapSchema = z.object({ services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])) });

export async function fetchBootstrap(opts: Opts = {}): Promise<{ ok: true; services: Services } | { ok: false; error: string }> {
  const r = await getJson(BOOTSTRAP_URL, "application/json", opts);
  if (!r.ok) return { ok: false, error: "Couldn't read IANA's RDAP list" };
  if (r.status !== 200) return { ok: false, error: `IANA's RDAP list returned an error (${r.status})` };
  const p = bootstrapSchema.safeParse(r.body);
  return p.success ? { ok: true, services: p.data.services } : { ok: false, error: "IANA's RDAP list is in a format the console doesn't recognise" };
}

export async function lookupDomain(name: string, base: string, opts: Opts = {}): Promise<{ ok: true; expiresAt: string | null; registrar: string | null } | { ok: false; error: string }> {
  const url = `${base.endsWith("/") ? base : `${base}/`}domain/${encodeURIComponent(bare(name))}`;
  const r = await getJson(url, "application/rdap+json, application/json", opts);
  if (!r.ok) return r;
  if (r.status === 404) return { ok: false, error: "The registry doesn't know this domain" };
  if (r.status !== 200) return { ok: false, error: `The registry's RDAP server returned an error (${r.status})` };
  const parsed = parseRdapDomain(r.body);
  return parsed ? { ok: true, ...parsed } : { ok: false, error: "The registry answered in a format the console doesn't recognise" };
}
