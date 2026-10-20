import { USAGE_COPY } from "@/lib/copy/edition";
import { wibDayStart } from "./usage-analytics";

// AI › Quota "Provider usage" (pure; owner 14 Oct): per connected provider, today (WIB) and the last 7 days of model
// work through Watchbell — requests, tokens (new input / cached / output incl. thinking) and failed calls — from
// ai_usage rows of kinds chat, console, models and agent. Antigravity's runs (kind agent, no provider) are their own
// "via your VM" entry when there are any. Owner-entered limits are shown as bars only where set.

export const PROVIDER_USAGE_KINDS = ["chat", "console", "models", "agent"] as const;
export const VM_PROVIDER_ID = "vm-agent";

export type ProviderUsageRow = {
  at: Date; kind: string; providerId: string | null;
  tokensIn: number | null; tokensCached: number | null; tokensOut: number | null; tokensThinking: number | null; status: number;
};
export type UsageTotals = { requests: number; input: number; cached: number; output: number; errors: number };
export type ProviderUsage = { id: string; name: string; kind: string; enabled: boolean; today: UsageTotals; week: UsageTotals };

const empty = (): UsageTotals => ({ requests: 0, input: 0, cached: 0, output: 0, errors: 0 });
const n = (v: number | null) => v ?? 0;
const DAY = 86_400_000;

function add(t: UsageTotals, r: ProviderUsageRow) {
  t.requests++;
  t.input += n(r.tokensIn);
  t.cached += n(r.tokensCached);
  t.output += n(r.tokensOut) + n(r.tokensThinking);
  if (r.status >= 400) t.errors++;
}

export function providerUsage(
  rows: ProviderUsageRow[], providers: { id: string; name: string; kind: string; enabled: boolean }[], now: Date,
): ProviderUsage[] {
  const today = wibDayStart(now.getTime());
  const weekStart = now.getTime() - 7 * DAY;
  const list: ProviderUsage[] = providers.map((p) => ({ ...p, today: empty(), week: empty() }));
  const byId = new Map(list.map((p) => [p.id, p]));
  let vm: ProviderUsage | null = null;
  for (const r of rows) {
    if (!(PROVIDER_USAGE_KINDS as readonly string[]).includes(r.kind)) continue;
    const t = r.at.getTime();
    if (t < weekStart || t > now.getTime()) continue;
    let p = r.providerId ? byId.get(r.providerId) : undefined;
    if (!p && !r.providerId && r.kind === "agent") {
      vm ??= { id: VM_PROVIDER_ID, name: USAGE_COPY.providerName, kind: "agent", enabled: true, today: empty(), week: empty() };
      p = vm;
    }
    if (!p) continue; // a provider that was removed
    add(p.week, r);
    if (t >= today) add(p.today, r);
  }
  return vm ? [...list, vm] : list;
}

// "1.2k" style for the token cells.
export const compactNumber = (v: number): string => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
