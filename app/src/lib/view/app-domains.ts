import { storedDomains } from "@/lib/domain-move";

// The app page's Details card lists every domain the app has on Vercel (Watchbell 1.2.1): the primary one first, the
// other attached ones, then the former ones. Pure: the ordering and the tags, nothing about rendering.
export type DomainFlag = { redirect: string | null; verified: boolean };
export type DomainLine = { name: string; tag: "primary" | "redirect" | "pending" | "former" | null; target: string | null };
export type DomainLines = { lines: DomainLine[]; more: number };

const FORMER_MAX = 3;
const bare = (s: string) => s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

// `meta` is the app's resources.meta (storedDomains), `flags` the redirect/verified state of its domain rows by name,
// `fallback` today's single domain for an app Watchbell has stored nothing for.
export function appDomainLines(meta: Record<string, unknown> | null | undefined, flags: Record<string, DomainFlag>, fallback: string): DomainLines {
  const own = storedDomains(meta);
  if (!own) return { lines: [{ name: fallback, tag: null, target: null }], more: 0 };
  const attached = [own.primaryDomain, ...own.domains.filter((n) => n !== own.primaryDomain)].filter((n, i, all) => all.indexOf(n) === i);
  const former = [...new Set(own.pastDomains)].filter((n) => !attached.includes(n)).reverse();
  const lines: DomainLine[] = attached.map((name, i) => {
    const f = flags[name];
    const base = { name, target: f?.redirect ? bare(f.redirect) : null };
    if (i === 0) return { ...base, tag: attached.length > 1 || former.length ? "primary" : null };
    return { ...base, tag: f?.redirect ? "redirect" : f && !f.verified ? "pending" : null };
  });
  lines.push(...former.slice(0, FORMER_MAX).map((name) => ({ name, tag: "former" as const, target: null })));
  return { lines, more: Math.max(0, former.length - FORMER_MAX) };
}
