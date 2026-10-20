import type { ExtensionNavGroup } from "@/lib/extensions";
import type { Role } from "@/lib/roles";

export type NavIconKey =
  | "dashboard" | "topology" | "activity" | "apps" | "rocket" | "world" | "sitemap" | "bolt" | "database"
  | "flame" | "books" | "heartbeat" | "bell" | "file" | "broadcast" | "plug" | "cloud-upload" | "settings"
  | "route" | "api" | "github" | "terminal" | "cloud";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: NavIconKey;
  stage: number;
  ownerOnly?: boolean;
  hideForViewer?: boolean;
};

export const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Home", items: [
    { key: "overview", label: "Overview", href: "/overview", icon: "dashboard", stage: 2 },
    { key: "topology", label: "Topology", href: "/topology", icon: "topology", stage: 4 },
    { key: "events", label: "Events", href: "/events", icon: "activity", stage: 2 },
  ] },
  { group: "Workloads", items: [
    { key: "apps", label: "Applications", href: "/apps", icon: "apps", stage: 2 },
    { key: "deployments", label: "Deployments", href: "/deployments", icon: "rocket", stage: 2 },
  ] },
  // Owner 16 Oct: a read-only browser of the synced repositories (README, files, commits, branches, Actions, CVEs).
  { group: "GitHub", items: [
    { key: "repos", label: "Repositories", href: "/repos", icon: "github", stage: 9 },
  ] },
  { group: "Network", items: [
    { key: "domains", label: "Domains", href: "/domains", icon: "world", stage: 4 },
    { key: "dns", label: "DNS records", href: "/dns", icon: "sitemap", stage: 4 },
  ] },
  { group: "Databases", items: [
    { key: "supabase", label: "Supabase", href: "/supabase", icon: "bolt", stage: 3 },
    { key: "neon", label: "Neon", href: "/neon", icon: "database", stage: 3 },
    { key: "firebase", label: "Firebase", href: "/firebase", icon: "flame", stage: 3 },
    { key: "turso", label: "Turso", href: "/turso", icon: "database", stage: 8 },
    { key: "upstash", label: "Upstash Redis", href: "/upstash", icon: "bolt", stage: 8 },
    { key: "d1", label: "Cloudflare D1", href: "/d1", icon: "cloud", stage: 8 },
    { key: "sql", label: "SQL console", href: "/sql", icon: "terminal", stage: 9, ownerOnly: true },
    { key: "catalog", label: "Free databases", href: "/catalog", icon: "books", stage: 7 },
  ] },
  { group: "Observe", items: [
    { key: "uptime", label: "Uptime", href: "/uptime", icon: "heartbeat", stage: 2 },
    { key: "alerts", label: "Alerts", href: "/alerts", icon: "bell", stage: 5 },
    { key: "logs", label: "Logs", href: "/logs", icon: "file", stage: 5, hideForViewer: true },
    { key: "status", label: "Provider status", href: "/status", icon: "broadcast", stage: 5 },
  ] },
  { group: "Administration", items: [
    { key: "connections", label: "Connections", href: "/connections", icon: "plug", stage: 1, ownerOnly: true },
    { key: "backups", label: "Backups", href: "/backups", icon: "cloud-upload", stage: 7, ownerOnly: true },
    { key: "settings", label: "Settings", href: "/settings", icon: "settings", stage: 1, ownerOnly: true },
  ] },
];

export function canSee(item: NavItem, role: Role): boolean {
  if (item.ownerOnly) return role === "owner";
  if (item.hideForViewer) return role !== "viewer";
  return true;
}

// Extension groups (5c, R1) come from @/lib/extensions on the server. This module stays registry-free because client
// components import it: the (console) layout passes the owner's groups down as props, server pages pass `extensions`.
export type NavExtension = { nav: ExtensionNavGroup[] };
const NO_EXTENSION: NavExtension = { nav: [] };

// The core groups with each extension group inserted after its `after` group (appended when that group is unknown).
export function navGroups(ext: NavExtension = NO_EXTENSION): { group: string; items: NavItem[] }[] {
  const out: { group: string; items: NavItem[] }[] = [...NAV];
  for (const g of ext.nav) {
    const at = out.findIndex((x) => x.group === g.after);
    const entry = { group: g.group, items: g.items };
    if (at < 0) out.push(entry);
    else out.splice(at + 1, 0, entry);
  }
  return out;
}

export function visibleNav(role: Role, ext: NavExtension = NO_EXTENSION) {
  return navGroups(ext).map((g) => ({ ...g, items: g.items.filter((i) => canSee(i, role)) })).filter((g) => g.items.length > 0);
}

export function findNav(pathname: string, ext: NavExtension = NO_EXTENSION): NavItem | null {
  const first = "/" + (pathname.split("/").filter(Boolean)[0] ?? "");
  return navGroups(ext).flatMap((g) => g.items).find((i) => i.href === first) ?? null;
}

export function activeKey(pathname: string, ext: NavExtension = NO_EXTENSION): string | null {
  return findNav(pathname, ext)?.key ?? null;
}

export function groupOf(key: string, ext: NavExtension = NO_EXTENSION): string {
  return navGroups(ext).find((g) => g.items.some((i) => i.key === key))?.group ?? "";
}
