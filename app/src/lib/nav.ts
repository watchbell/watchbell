import type { ExtensionNavGroup } from "@/lib/extensions";
import type { Role } from "@/lib/roles";
import { SECTION_IDS, SECTIONS, type SectionId } from "@/lib/sections";

export type NavIconKey =
  | "dashboard" | "topology" | "activity" | "apps" | "rocket" | "world" | "sitemap" | "bolt" | "database"
  | "flame" | "books" | "heartbeat" | "bell" | "file" | "broadcast" | "plug" | "cloud-upload" | "settings"
  | "route" | "api" | "github" | "terminal" | "cloud" | "layout" | "page";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: NavIconKey;
  stage: number;
  ownerOnly?: boolean;
  hideForViewer?: boolean;
  // A sub-heading inside the section (DevOps › Automation); items with the same `sub` sit together under it.
  sub?: string;
};

// One menu group per section (lib/sections.ts), in section order; `group` is the section's label.
export type NavGroup = { section: SectionId; group: string; items: NavItem[] };

// Watchbell 1.2 (spec §5): today's pages regrouped into sections. Only the menu grouping changed; every URL is the same.
const ITEMS: Record<SectionId, NavItem[]> = {
  home: [
    { key: "overview", label: "Overview", href: "/overview", icon: "dashboard", stage: 2 },
    { key: "topology", label: "Topology", href: "/topology", icon: "topology", stage: 4 },
    { key: "events", label: "Events", href: "/events", icon: "activity", stage: 2 },
    { key: "status", label: "Provider status", href: "/status", icon: "broadcast", stage: 5 },
  ],
  hosting: [
    { key: "apps", label: "Applications", href: "/apps", icon: "apps", stage: 2 },
    { key: "deployments", label: "Deployments", href: "/deployments", icon: "rocket", stage: 2 },
    { key: "domains", label: "Domains", href: "/domains", icon: "world", stage: 4 },
    { key: "dns", label: "DNS records", href: "/dns", icon: "sitemap", stage: 4 },
    { key: "uptime", label: "Uptime", href: "/uptime", icon: "heartbeat", stage: 2 },
    { key: "logs", label: "Logs", href: "/logs", icon: "file", stage: 5, hideForViewer: true },
  ],
  database: [
    { key: "supabase", label: "Supabase", href: "/supabase", icon: "bolt", stage: 3 },
    { key: "neon", label: "Neon", href: "/neon", icon: "database", stage: 3 },
    { key: "firebase", label: "Firebase", href: "/firebase", icon: "flame", stage: 3 },
    { key: "turso", label: "Turso", href: "/turso", icon: "database", stage: 8 },
    { key: "upstash", label: "Upstash Redis", href: "/upstash", icon: "bolt", stage: 8 },
    { key: "d1", label: "Cloudflare D1", href: "/d1", icon: "cloud", stage: 8 },
    { key: "sql", label: "SQL console", href: "/sql", icon: "terminal", stage: 9, ownerOnly: true },
    { key: "catalog", label: "Free databases", href: "/catalog", icon: "books", stage: 7 },
  ],
  // Owner 16 Oct: a read-only browser of the synced repositories (README, files, commits, branches, Actions, CVEs).
  devops: [
    { key: "repos", label: "Repositories", href: "/repos", icon: "github", stage: 9, sub: "Automation" },
  ],
  // Alerts sit here for every role (the bell in the top bar too); the rest is the owner's. Extension pages (Auto-actions
  // after Alerts, AI Gateway and API explorer after Settings) are inserted by navGroups.
  manage: [
    { key: "connections", label: "Connections", href: "/connections", icon: "plug", stage: 1, ownerOnly: true },
    { key: "alerts", label: "Alerts", href: "/alerts", icon: "bell", stage: 5 },
    { key: "sections", label: "Sections", href: "/manage/sections", icon: "layout", stage: 12, ownerOnly: true },
    { key: "settings", label: "Settings", href: "/settings", icon: "settings", stage: 1, ownerOnly: true },
    { key: "backups", label: "Backups", href: "/backups", icon: "cloud-upload", stage: 7, ownerOnly: true },
    { key: "status-page", label: "Status page", href: "/settings?tab=status-page", icon: "page", stage: 7, ownerOnly: true },
  ],
};

export const NAV: NavGroup[] = SECTION_IDS.map((section) => ({ section, group: SECTIONS[section].label, items: ITEMS[section] }));

export function canSee(item: NavItem, role: Role): boolean {
  if (item.ownerOnly) return role === "owner";
  if (item.hideForViewer) return role !== "viewer";
  return true;
}

// Extension groups (5c, R1) come from @/lib/extensions on the server. This module stays registry-free because client
// components import it: the (console) layout passes the owner's groups down as props, server pages pass `extensions`.
export type NavExtension = { nav: ExtensionNavGroup[] };
const NO_EXTENSION: NavExtension = { nav: [] };

// The core sections with each extension group's items placed in its section, right after the item whose key is its
// `after` (at the section's end when that item is missing). A group naming no known section goes to Manage.
export function navGroups(ext: NavExtension = NO_EXTENSION): NavGroup[] {
  const out: NavGroup[] = NAV.map((g) => ({ ...g, items: [...g.items] }));
  for (const g of ext.nav) {
    const target = out.find((x) => x.section === g.section) ?? out.find((x) => x.section === "manage")!;
    const at = g.after ? target.items.findIndex((i) => i.key === g.after) : -1;
    if (at < 0) target.items.push(...g.items);
    else target.items.splice(at + 1, 0, ...g.items);
  }
  return out;
}

// `on`: the sections shown (lib/sections.ts sectionsOn); without it every section is shown.
export function visibleNav(role: Role, ext: NavExtension = NO_EXTENSION, on?: Iterable<SectionId>) {
  const shown = on ? new Set(on) : null;
  return navGroups(ext)
    .filter((g) => !shown || shown.has(g.section))
    .map((g) => ({ ...g, items: g.items.filter((i) => canSee(i, role)) }))
    .filter((g) => g.items.length > 0);
}

const pathOf = (href: string) => href.split("?")[0];

// Whether every query parameter of an href (Status page: ?tab=status-page) is in the current search.
function queryMatches(href: string, search: URLSearchParams | null): boolean {
  const q = href.split("?")[1];
  if (!q) return true;
  if (!search) return false;
  return [...new URLSearchParams(q)].every(([k, v]) => search.get(k) === v);
}

// The item a path belongs to: the longest href that is the path or a parent of it (/apps/x → Applications,
// /manage/sections → Sections). An href with a query counts only when the current search has it, and then wins over
// the plain one (/settings?tab=status-page → Status page; /settings → Settings).
export function findNav(pathname: string, ext: NavExtension = NO_EXTENSION, search?: string | URLSearchParams | null): NavItem | null {
  const [p, inline] = pathname.split("?");
  const path = p.replace(/\/+$/, "") || "/";
  const params = search != null ? new URLSearchParams(search) : inline !== undefined ? new URLSearchParams(inline) : null;
  let best: NavItem | null = null;
  for (const item of navGroups(ext).flatMap((g) => g.items)) {
    const base = pathOf(item.href);
    if (path !== base && !path.startsWith(`${base}/`)) continue;
    const hasQuery = item.href.includes("?");
    if (hasQuery && (path !== base || !queryMatches(item.href, params))) continue;
    const bestBase = best ? pathOf(best.href).length : -1;
    const better = !best || base.length > bestBase || (base.length === bestBase && hasQuery && !best.href.includes("?"));
    if (better) best = item;
  }
  return best;
}

export function activeKey(pathname: string, ext: NavExtension = NO_EXTENSION, search?: string | URLSearchParams | null): string | null {
  return findNav(pathname, ext, search)?.key ?? null;
}

export function groupOf(key: string, ext: NavExtension = NO_EXTENSION): string {
  return navGroups(ext).find((g) => g.items.some((i) => i.key === key))?.group ?? "";
}

export function sectionOf(key: string, ext: NavExtension = NO_EXTENSION): SectionId | null {
  return navGroups(ext).find((g) => g.items.some((i) => i.key === key))?.section ?? null;
}
