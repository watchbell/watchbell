// Watchbell 1.8.6: Alerts › Sources, the view logic the page and the wizard share (pure, safe in a client component).
export const WIZARD_POLL_MS = 5_000;
export const WIZARD_POLL_MAX_MS = 120_000;
const QUIET_MS = 7 * 86_400_000;

export type SourceState = "none" | "active" | "quiet" | "revoked";

// quiet: set up, but nothing arrived for 7 days (or nothing at all, 7 days after set-up).
export function sourceState(src: { enabled: boolean; createdAt: Date; lastSeenAt: Date | null } | null, now: Date): SourceState {
  if (!src) return "none";
  if (!src.enabled) return "revoked";
  const since = (src.lastSeenAt ?? src.createdAt).getTime();
  return now.getTime() - since > QUIET_MS ? "quiet" : "active";
}

const base = (origin: string) => `${origin.replace(/\/+$/, "")}/api/alertmanager/`;

// The real URL is built only in the one response that shows it (setupSourceAction).
export const ingestUrl = (origin: string, token: string): string => `${base(origin)}${token}`;
export const maskedUrl = (origin: string, prefix: string): string => `${base(origin)}${prefix}…`;

// max_alerts keeps a big group within the route's 100 alerts a call; send_resolved lets Watchbell close the alert.
// A child route with continue: true (final review M7): merged into an existing alertmanager.yml it adds Watchbell
// beside the user's own receivers instead of replacing them. repeat_interval stays under the 24 h stale limit (M8).
export function alertmanagerYml(url: string): string {
  return [
    "# 1. Under receivers:",
    "receivers:",
    "  - name: watchbell",
    "    webhook_configs:",
    `      - url: ${url}`,
    "        send_resolved: true",
    "        max_alerts: 100",
    "",
    "# 2. As the first entry of your route's routes: (your own receiver and routes stay as they are)",
    "route:",
    "  routes:",
    "    - receiver: watchbell",
    "      continue: true",
    "      repeat_interval: 4h",
  ].join("\n");
}

// Firing's source filter: where an open alert came from. ExternalAlert = Prometheus Alertmanager; every other rule is Watchbell's.
export type SourceFilter = "all" | "watchbell" | "alertmanager";
export const isSourceFilter = (v: unknown): v is SourceFilter => v === "all" || v === "watchbell" || v === "alertmanager";
export function filterBySource<T extends { ruleKey: string }>(rows: T[], source: SourceFilter): T[] {
  if (source === "all") return rows;
  return rows.filter((r) => (r.ruleKey === "ExternalAlert") === (source === "alertmanager"));
}
