import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts, appSecurity, links, monitors, recommendationDismissals, resources, settings, snapshots } from "@/db/schema";
import { pathOf } from "@/lib/collector/deploy-sync";
import { type AdvisorFacts, MAX_RECS, type Rec, recommendations, visible } from "@/lib/advisor/rules";
import { DB_KINDS, type DbKind, dbProvider } from "@/lib/links";
import type { EolData } from "@/lib/security/eol";
import { slotCards } from "@/lib/view/databases";
import { PAGE_ROWS } from "@/lib/view/windows";
import { supabaseSlotInputs } from "./databases-db";
import { readEol } from "./network-db";

// R3: the Advisor's reads and writes. The daily job computes the items and stores them under ops.settings
// "advisor.latest"; the pages read that row and the dismissals, never the facts, so they stay one cheap read each and
// a Dismiss shows on the next render (nothing here is cached, so there is no tag to expire). Only console rows change.

export const ADVISOR_KEY = "advisor.latest";
const KEY_MAX = 200;
const ACCOUNT_ROWS = 200;

const recSchema = z.object({
  key: z.string(), severity: z.enum(["warning", "info"]), appId: z.string().nullable(), subject: z.string(), title: z.string(),
  why: z.string(), fix: z.string(), href: z.string(),
});
const storedSchema = z.object({ at: z.string(), items: z.array(recSchema) });

type EolApp = { id: string; name: string; version: string | null };

// Each watched app's Next.js major (the version the security check read) against endoflife.date's cycles. `latest` is
// the newest supported release, the one to move to. An app whose version or cycle is unknown has no fact.
export function toEolFacts(apps: EolApp[], data: EolData | null): AdvisorFacts["eol"] {
  if (!data) return null;
  const newest = data.cycles.find((c) => !c.isEol)?.latest ?? null;
  const out: NonNullable<AdvisorFacts["eol"]> = [];
  for (const a of apps) {
    const major = a.version?.split(".")[0];
    const cycle = major ? data.cycles.find((c) => c.name === major) : undefined;
    if (!cycle) continue;
    out.push({ appId: a.id, appName: a.name, cycle: cycle.name, eolFrom: cycle.eolFrom ? new Date(`${cycle.eolFrom}T00:00:00Z`) : null, latest: newest });
  }
  return out;
}

// Everything the rules look at, in bounded reads (R8). Credentials are never selected, only an account's label,
// expiry and scope note. `headers` stays null until the security-headers check (stage 4, P3) exists.
export async function loadAdvisorFacts(now: Date): Promise<AdvisorFacts> {
  const watchedApp = and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt));
  // Read first on their own: the daily job isn't latency-sensitive, and the order of the reads stays plain.
  const eolData = await readEol();
  // Every Supabase project of every account, watched or not (a free slot is used by both), with the org's plan.
  const slotInputs = await supabaseSlotInputs();
  const [mons, versions, dbRows, linkRows, accountRows] = await Promise.all([
    db().select({
      id: monitors.id, appId: monitors.resourceId, appName: resources.name, url: monitors.url, kind: monitors.kind, name: monitors.name,
      paused: monitors.paused, ownerPaused: monitors.ownerPaused,
      lastStatus: monitors.lastStatus, expectedStatus: monitors.expectedStatus, lastPingAt: monitors.lastPingAt, createdAt: monitors.createdAt,
    }).from(monitors).innerJoin(resources, eq(resources.id, monitors.resourceId)).where(watchedApp)
      .orderBy(resources.name, monitors.url).limit(PAGE_ROWS.monitors),
    db().select({ id: resources.id, name: resources.name, version: appSecurity.version }).from(resources)
      .innerJoin(appSecurity, eq(appSecurity.resourceId, resources.id)).where(watchedApp).orderBy(resources.name).limit(PAGE_ROWS.apps),
    db().select({ id: resources.id, name: resources.name, kind: resources.kind, accountId: resources.accountId, accountLabel: accounts.label, state: snapshots.state }).from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
      .where(and(inArray(resources.kind, [...DB_KINDS]), eq(resources.monitored, true), isNull(resources.goneAt)))
      .orderBy(resources.name).limit(PAGE_ROWS.databases),
    db().select({ appId: links.fromResourceId, dbId: links.toResourceId }).from(links).where(eq(links.kind, "uses_db")).limit(PAGE_ROWS.apps),
    db().select({ id: accounts.id, provider: accounts.provider, label: accounts.label, expiresAt: accounts.expiresAt, scopeNote: accounts.scopeNote }).from(accounts)
      .orderBy(accounts.label).limit(ACCOUNT_ROWS),
  ]);
  return {
    now,
    monitors: mons.map((m) => ({
      id: m.id, appId: m.appId, appName: m.appName, path: m.kind === "heartbeat" ? m.url : pathOf(m.url), kind: m.kind, name: m.name,
      paused: m.paused || m.ownerPaused,
      lastStatus: m.lastStatus, expectedStatus: m.expectedStatus, lastPingAt: m.lastPingAt, createdAt: m.createdAt,
    })),
    eol: toEolFacts(versions, eolData),
    headers: null,
    dbs: dbRows.map((d) => ({ id: d.id, name: d.name, provider: dbProvider(d.kind as DbKind), accountId: d.accountId, accountLabel: d.accountLabel, state: d.state ?? "unknown" })),
    slots: slotCards(slotInputs).map((c) => ({ account: c.account, used: c.used, total: c.total, planUnknown: c.planUnknown })),
    links: linkRows,
    accounts: accountRows,
  };
}

// The daily job's "advisor" step (and the first view after a deploy): compute and store.
export async function runAdvisor(now: Date): Promise<Rec[]> {
  const items = recommendations(await loadAdvisorFacts(now));
  const value = { at: now.toISOString(), items };
  await db().insert(settings).values({ key: ADVISOR_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  return items;
}

// The stored items; computed once when none are stored (first deploy) or the stored value isn't readable.
async function latest(now: Date): Promise<Rec[]> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, ADVISOR_KEY)).limit(1);
  const parsed = storedSchema.safeParse(row?.value);
  return parsed.success ? parsed.data.items : runAdvisor(now);
}

// What the pages show: the stored items minus the ones dismissed in the last 30 days, optionally one app's.
export async function listRecommendations(now: Date, appId?: string): Promise<Rec[]> {
  const items = await latest(now);
  if (!items.length) return [];
  const rows = await db().select({ key: recommendationDismissals.key, dismissedAt: recommendationDismissals.dismissedAt })
    .from(recommendationDismissals).where(inArray(recommendationDismissals.key, items.map((r) => r.key))).limit(MAX_RECS);
  const shown = visible(items, new Map(rows.map((r) => [r.key, r.dismissedAt])), now);
  return appId ? shown.filter((r) => r.appId === appId) : shown;
}

export type DismissDone = { ok: true; title: string; appId: string | null } | { ok: false; error: string };

// Only a key on the current list can be dismissed, so the table can't be filled with arbitrary text.
export async function dismiss(key: string, by: string, now: Date): Promise<DismissDone> {
  if (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX) return { ok: false, error: "Something in that request wasn't valid." };
  const rec = (await latest(now)).find((r) => r.key === key);
  if (!rec) return { ok: false, error: "That item is no longer on the list." };
  await db().insert(recommendationDismissals).values({ key, dismissedAt: now, dismissedBy: by })
    .onConflictDoUpdate({ target: recommendationDismissals.key, set: { dismissedAt: now, dismissedBy: by } });
  return { ok: true, title: rec.title, appId: rec.appId };
}
