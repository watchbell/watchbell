import type { ClientExtension } from "@/lib/extensions";
import { type NavIconKey, visibleNav } from "@/lib/nav";
import type { Role } from "@/lib/roles";

export const PALETTE_MAX = 20;

// keywords (extension entries only) match after the label and the hint, never shown.
export type PaletteItem = { id: string; label: string; hint: string; href: string; icon: NavIconKey; keywords?: string[] };
export type PaletteSource = {
  apps: { id: string; name: string; domain: string }[];
  monitors: { id: string; appId: string; appName: string; path: string }[];
  // Watched domains (what the Domains page lists); absent from an older payload.
  domains?: { id: string; name: string }[];
};

// 0 = the text starts with the query, 1 = a word of it does ("data" in "Free databases"), 2 = it appears inside, null = no match.
// A multi-word query is matched as one phrase. Case-insensitive.
export function matchRank(text: string, query: string): 0 | 1 | 2 | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at < 0) return null;
  if (at === 0) return 0;
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) {
    if (!/[a-z0-9]/.test(t[i - 1] ?? " ")) return 1;
  }
  return 2;
}

// Label 0–2, hint 3–5, keyword 6–8 (null = no match).
function itemScore(item: PaletteItem, query: string): number | null {
  const label = matchRank(item.label, query);
  if (label !== null) return label;
  const hint = matchRank(item.hint, query);
  if (hint !== null) return hint + 3;
  const kw = (item.keywords ?? []).map((k) => matchRank(k, query)).filter((r) => r !== null);
  return kw.length ? Math.min(...kw) + 6 : null;
}

// The label outranks the hint: any label match comes before any hint match (a hint is the page group or the domain).
// Inside a rank the given order is kept, so pages stay ahead of apps. An empty query shows the first items as given.
export function rankItems(items: PaletteItem[], query: string, max = PALETTE_MAX): PaletteItem[] {
  if (!query.trim()) return items.slice(0, max);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const score = itemScore(item, query);
    if (score !== null) scored.push({ item, score });
  }
  // Array.prototype.sort is stable.
  return scored.sort((a, b) => a.score - b.score).slice(0, max).map((s) => s.item);
}

// Screenshot mode: `shown` is `items` as displayed (masked, same order). An item matches by either text, at its better
// rank, and comes back as shown.
export function rankShown(items: PaletteItem[], shown: PaletteItem[], query: string, max = PALETTE_MAX): PaletteItem[] {
  if (!query.trim()) return shown.slice(0, max);
  const score = (it: PaletteItem) => itemScore(it, query);
  const scored: { item: PaletteItem; score: number }[] = [];
  items.forEach((it, i) => {
    const a = score(it);
    const b = score(shown[i]);
    const best = a === null ? b : b === null ? a : Math.min(a, b);
    if (best !== null) scored.push({ item: shown[i], score: best });
  });
  return scored.sort((a, b) => a.score - b.score).slice(0, max).map((s) => s.item);
}

// Pages first (the same nav config as the sidebar, so a role never sees a page it cannot open), then watched apps, then watched domains, then monitors.
// Extension entries (5c, owner only: the layout sends them to owners alone, and they are dropped here for anyone else)
// follow the pages; each takes the group and icon of the extension nav item it lives under.
export function buildItems(role: Role, source: PaletteSource | null, ext: ClientExtension = { nav: [], palette: [] }): PaletteItem[] {
  const groups = visibleNav(role, ext);
  const pages = groups.flatMap((g) => g.items.map((i): PaletteItem => ({ id: `page:${i.key}`, label: i.label, hint: g.group, href: i.href, icon: i.icon })));
  const extra = role !== "owner" ? [] : ext.palette.filter((e) => !pages.some((p) => p.href === e.href)).map((e): PaletteItem => {
    const under = ext.nav.flatMap((g) => g.items.map((i) => ({ g, i }))).find(({ i }) => e.href === i.href || e.href.startsWith(`${i.href}/`));
    return { id: `ext:${e.href}`, label: e.label, hint: under ? `${under.g.group} · ${under.i.label}` : "Page", href: e.href, icon: under?.i.icon ?? "dashboard", keywords: e.keywords };
  });
  const all = [...pages, ...extra];
  if (!source) return all;
  const apps = source.apps.map((a): PaletteItem => ({ id: `app:${a.id}`, label: a.name, hint: a.domain, href: `/apps/${a.id}`, icon: "apps" }));
  const monitors = source.monitors.map((m): PaletteItem => ({ id: `monitor:${m.id}`, label: `${m.appName}${m.path}`, hint: "Monitor", href: `/apps/${m.appId}`, icon: "heartbeat" }));
  // The Domains page has no per-row link, so a domain opens that page. The real name is the label, so searching matches it;
  // screenshot mode masks it in the dialog like any app (command-palette.tsx).
  const domains = (source.domains ?? []).map((d): PaletteItem => ({ id: `domain:${d.id}`, label: d.name, hint: "Domain", href: "/domains", icon: "world" }));
  return [...all, ...apps, ...domains, ...monitors];
}
