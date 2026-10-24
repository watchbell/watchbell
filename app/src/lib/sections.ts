import type { Provider } from "@/lib/providers/info";

// Watchbell 1.2 (D11): the console's pages are grouped into sections. A section is a UI and feature switch over the
// install's data, not a data boundary. Home and Manage are always on. Hosting is on from the start, so Uptime and the
// welcome steps are always in the menu (owner ruling, review A1); its checks still belong to a watched app. Database and DevOps come on by themselves when a provider of
// theirs is connected (Database also once a database is watched). The owner can turn Hosting, Database or DevOps off in
// Manage › Sections: it is then hidden from the menu and its collector tasks, alert evaluation, notifications and new
// auto-action proposals pause. Its data is kept, every URL keeps working, and the protective writes the owner asked
// for (Keep active, Auto-restore) keep running. Pure and client-safe: the sidebar imports it.

export type SectionId = "home" | "hosting" | "database" | "devops" | "manage";

// Menu order. Cloud and DevOps › Infra are reserved for later releases (spec §5) and not shown yet.
export const SECTION_IDS = ["home", "hosting", "database", "devops", "manage"] as const satisfies readonly SectionId[];

// The sections a user can turn off. Home and Manage hold the overview, connections and settings, so they never go.
export const SWITCHABLE: readonly SectionId[] = ["hosting", "database", "devops"];

// keeps: what goes on while the section is off (the protective writes the owner asked for).
export const SECTIONS: Record<SectionId, { label: string; holds: string; appears: string; keeps?: string }> = {
  home: { label: "Home", holds: "Overview, Topology, Events and Provider status.", appears: "Always on." },
  hosting: {
    label: "Hosting", holds: "Applications, Deployments, Domains, DNS records, Uptime and Logs.",
    appears: "On from the start, so Uptime is always in the menu.",
  },
  database: {
    label: "Database", holds: "Supabase, Neon, Firebase, Turso, Upstash Redis, Cloudflare D1, the SQL console and Free databases.",
    appears: "Appears when you connect Supabase, Neon, Firebase, Turso or Upstash, or once a database is watched.",
    keeps: "Keep active and Auto-restore keep running while it is off, so your free Supabase projects aren't paused.",
  },
  devops: { label: "DevOps", holds: "Automation: GitHub repositories, their Actions runs and dependency advisories.", appears: "Appears when you connect GitHub." },
  manage: { label: "Manage", holds: "Connections, Alerts, Auto-actions, Sections, Settings, AI gateway, API explorer, Status page and Backups.", appears: "Always on." },
};

// Which section a provider's account turns on (one data map; Task A2's Connections grid groups by it too).
export const SECTION_OF_PROVIDER = { vercel: "hosting", cloudflare: "hosting", supabase: "database", neon: "database", firebase: "database", turso: "database", upstash: "database", github: "devops", github_write: "devops" } as const satisfies Record<Provider, SectionId>;

export const isSectionId = (v: unknown): v is SectionId => typeof v === "string" && (SECTION_IDS as readonly string[]).includes(v);
export const isSwitchable = (v: unknown): v is SectionId => isSectionId(v) && SWITCHABLE.includes(v);

// The stored `sections.off` value, cleaned: only switchable ids, each once, in menu order. Anything odd reads as [].
export function cleanSectionsOff(v: unknown): SectionId[] {
  if (!Array.isArray(v)) return [];
  return SECTION_IDS.filter((id) => isSwitchable(id) && v.includes(id));
}

// What the install already has besides its accounts: an existing database resource keeps Database on, so an upgraded
// install loses no section that has data. (Hosting needs nothing: it is always available.)
export type SectionData = { databases?: boolean };

// The sections available before the owner's switches: Home, Hosting and Manage always; Database and DevOps when a
// provider of theirs is connected (or, for Database, a database exists).
export function sectionsAvailable(connectedProviders: readonly Provider[], has: SectionData = {}): Set<SectionId> {
  const auto = new Set<SectionId>(["home", "hosting", "manage"]);
  for (const p of connectedProviders) {
    const s = (SECTION_OF_PROVIDER as Record<string, SectionId | undefined>)[p];
    if (s) auto.add(s);
  }
  if (has.databases) auto.add("database");
  return new Set(SECTION_IDS.filter((id) => auto.has(id)));
}

// The sections shown: the available ones the owner didn't turn off.
export function sectionsOn(connectedProviders: readonly Provider[], off: readonly SectionId[], has: SectionData = {}): Set<SectionId> {
  const offSet = new Set(cleanSectionsOff(off));
  return new Set([...sectionsAvailable(connectedProviders, has)].filter((id) => !offSet.has(id)));
}

// The providers that make an automatic section appear, for "Appears when you connect …".
export const SECTION_PROVIDER_NAMES: Partial<Record<SectionId, string>> = { database: "Supabase, Neon, Firebase, Turso or Upstash", devops: "GitHub" };

// The sections whose background work pauses: the ones turned off by hand. (A section hidden only because nothing of
// it is connected has nothing to sync or evaluate.)
export const pausedSections = (off: readonly SectionId[]): Set<SectionId> => new Set(cleanSectionsOff(off));

// The section an alert rule belongs to. "account": the section of the alert's account's provider (CredentialExpiring).
// null: always evaluated and delivered (the collector's own health).
export const RULE_SECTION: Record<string, SectionId | "account" | null> = {
  MonitorDown: "hosting", HighLatency: "hosting", DeploymentFailed: "hosting", CertExpiringSoon: "hosting", DomainExpiringSoon: "hosting", DnsProxiedToVercel: "hosting",
  DatabasePaused: "database", StorageAlmostFull: "database", NeonComputeHigh: "database", FirestoreQuotaHigh: "database", AutoPauseRisk: "database", ComputeHigh: "database", DbQuotaHigh: "database",
  VulnerableDependency: "devops",
  CredentialExpiring: "account",
  CollectorStale: null,
};

// Auto-action log rules (private/actions/log-proposals.ts) read Vercel's stored logs: Hosting.
const LOG_RULE = /^Log/;

export function alertSection(ruleKey: string, accountProvider?: string | null): SectionId | null {
  const s = RULE_SECTION[ruleKey];
  if (s === "account") return accountProvider ? (SECTION_OF_PROVIDER as Record<string, SectionId | undefined>)[accountProvider] ?? null : null;
  if (s !== undefined) return s;
  return LOG_RULE.test(ruleKey) ? "hosting" : null;
}

export const alertPaused = (paused: ReadonlySet<SectionId>, ruleKey: string, accountProvider?: string | null): boolean => {
  if (!paused.size) return false;
  const s = alertSection(ruleKey, accountProvider);
  return s !== null && paused.has(s);
};

// The rule keys (of RULE_SECTION) whose alerts pause with these sections, and the providers whose account alerts do.
export function pausedAlertKeys(paused: ReadonlySet<SectionId>): { ruleKeys: string[]; providers: Provider[] } {
  const ruleKeys = Object.entries(RULE_SECTION).filter(([, s]) => s !== null && s !== "account" && paused.has(s)).map(([k]) => k);
  const providers = (Object.entries(SECTION_OF_PROVIDER) as [Provider, SectionId][]).filter(([, s]) => paused.has(s)).map(([p]) => p);
  return { ruleKeys, providers };
}
