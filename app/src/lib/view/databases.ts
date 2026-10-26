import { type FirebaseData, firebaseData, neonData, readData, supabaseData } from "@/lib/databases/snapshot-data";
import { FIRESTORE_FREE, firestoreFailure } from "@/lib/databases/firebase";
import { autoscalingText, cuHours, endpointState, NEON_FREE, neonProjectState } from "@/lib/databases/neon";
import { autoPauseRisk, FREE_DB_BYTES, freeSlots, supabaseState, usesSlot } from "@/lib/databases/supabase";
import type { DbRow } from "@/lib/data/databases-db";
import type { State } from "@/lib/status";
import { ago, dayMonth } from "@/lib/time";
import { type AliasBook, dbAlias, EMPTY_BOOK, hideEmails } from "./display-name";
import { rel } from "./format";
import { type ProblemBanner, STATE_WORD, worst } from "./labels";

export type Shown = { state: State; label: string };
export type SlotInput = { id: string; account: string; name: string; status: string; freeOrg: boolean | null };
export type SlotCard = { account: string; used: number; total: number; left: number; planUnknown: boolean; active: string[]; activeIds: string[] };

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const round2 = (n: number) => Math.round(n * 100) / 100;
const date = (s: string | null | undefined) => (s ? new Date(s) : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function bytesText(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`;
}

// D6: a snapshot the provider couldn't refresh reads "Unknown · last seen paused".
function known(state: State, label: string, lastGood: string | undefined): Shown {
  if (state !== "unknown") return { state, label };
  return { state: "unknown", label: lastGood && lastGood in STATE_WORD ? `Unknown · last seen ${STATE_WORD[lastGood as State]}` : "Unknown" };
}

// `alias` is what the page shows for the database (privacy, display-name.ts); `name` stays for the click-to-reveal.
export type SupabaseView = {
  id: string; name: string; alias: string; ref: string; sub: string; account: string; status: Shown; since: string | null;
  size: { text: string; pct: number; asOf: string } | null; sizeNote: string | null;
  traffic: string; trafficNote: string | null; risk: { state: State; text: string; note: string | null };
  usedBy: { id: string; name: string }[]; stale: boolean; paused: boolean; sizeBytes: number | null;
};

export function supabaseRows(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): SupabaseView[] {
  return rows.map((r) => {
    const d = readData(supabaseData, r.data);
    const status = d.status ?? "";
    const pg = d.pgVersion ? `Postgres ${d.pgVersion.split(".").slice(0, 2).join(".")}` : null;
    const paused = r.state === "paused" || (r.state === "unknown" && d.lastGoodState === "paused");
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), ref: r.externalId, account: r.account, sub: [d.region, pg].filter(Boolean).join(" · "),
      status: known(r.state, supabaseState(status).label, d.lastGoodState),
      since: r.stateSince && r.state !== "unknown" ? ago(r.stateSince, now) : null,
      size: d.sizeBytes != null ? { text: bytesText(d.sizeBytes), pct: round2((d.sizeBytes / FREE_DB_BYTES) * 100), asOf: d.sizeAt ? ago(new Date(d.sizeAt), now) : "—" } : null,
      sizeNote: d.sizeError ?? (d.sizeBytes != null ? null : status === "ACTIVE_HEALTHY" ? "Read once a day while the project is in use" : "Read only while the project is active"),
      traffic: d.trafficAt && !d.trafficError ? (d.lastTrafficAt ? rel(new Date(d.lastTrafficAt), now) : "None in 7 days") : "—",
      trafficNote: d.trafficError ?? null,
      risk: autoPauseRisk({
        status: paused ? "INACTIVE" : status, lastTrafficAt: date(d.lastTrafficAt), trafficCheckedAt: date(d.trafficAt),
        pausedSince: paused ? r.stateSince : null, pausedBeforeSeen: d.pausedBeforeSeen ?? false, now,
      }),
      usedBy: r.usedBy, stale: r.state === "unknown", paused, sizeBytes: d.sizeBytes ?? null,
    };
  });
}

export function slotCards(inputs: SlotInput[]): SlotCard[] {
  const accounts = [...new Set(inputs.map((i) => i.account))].sort();
  return accounts.map((account) => {
    const mine = inputs.filter((i) => i.account === account);
    const active = mine.filter((i) => i.freeOrg !== false && usesSlot(i.status));
    return { account, ...freeSlots(mine), active: active.map((i) => i.name), activeIds: active.map((i) => i.id) };
  });
}

export function storageTotal(rows: SupabaseView[]): { text: string; count: number } {
  const sized = rows.filter((r) => r.sizeBytes !== null);
  return { text: bytesText(sized.reduce((n, r) => n + (r.sizeBytes ?? 0), 0)), count: sized.length };
}

export type NeonBranchView = { id: string; name: string; isDefault: boolean; endpoint: string | null; status: Shown; autoscaling: string; size: string; lastActive: string };
export type NeonBlock = {
  id: string; name: string; alias: string; account: string; region: string | null; pg: number | null; usedBy: { id: string; name: string }[];
  status: Shown; stale: boolean; collectedAt: Date | null;
  cu: { value: number; pct: number } | null; storage: { text: string; pct: number }; transfer: { text: string; pct: number } | null;
  resets: string | null; branches: NeonBranchView[];
  activeHours?: number | null; // Stage 12: active_time_seconds this period, in hours
};

export function neonBlocks(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): NeonBlock[] {
  return rows.map((r) => {
    const d = readData(neonData, r.data);
    const eps = d.endpoints ?? [];
    const branches = [...(d.branches ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    const used = branches.reduce((n, b) => n + (b.logicalSize ?? 0), 0);
    const cu = d.computeSeconds != null ? cuHours(d.computeSeconds) : null;
    const stale = r.state === "unknown";
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), account: r.account, region: d.region ?? null, pg: d.pgVersion ?? null, usedBy: r.usedBy, stale, collectedAt: r.collectedAt,
      status: known(r.state, neonProjectState({ endpoints: eps, computeSeconds: d.computeSeconds ?? null }).label, d.lastGoodState),
      cu: cu === null ? null : { value: cu, pct: round2((cu / NEON_FREE.cuHours) * 100) },
      storage: { text: bytesText(used), pct: round2((used / NEON_FREE.storageBytes) * 100) },
      transfer: d.transferBytes != null ? { text: bytesText(d.transferBytes), pct: round2((d.transferBytes / NEON_FREE.transferBytes) * 100) } : null,
      resets: d.periodEnd ? dayMonth(new Date(d.periodEnd)) : null,
      activeHours: d.activeSeconds != null ? Math.round(d.activeSeconds / 360) / 10 : null,
      branches: branches.map((b) => {
        const e = eps.find((x) => x.branchId === b.id);
        const st: Shown = e ? endpointState(e) : { state: "off", label: "No compute" };
        return {
          id: b.id, name: b.name, isDefault: b.isDefault, endpoint: e?.id ?? null,
          status: stale ? known("unknown", "", st.state) : st,
          autoscaling: e ? autoscalingText(e.minCu, e.maxCu) : "—", size: bytesText(b.logicalSize), lastActive: e?.lastActive ? rel(new Date(e.lastActive), now) : "—",
        };
      }),
    };
  });
}

export type FirebaseView = {
  id: string; name: string; alias: string; projectId: string; account: string; health: Shown; stale: boolean;
  ops: { reads: { n: number; pct: number } | null; writes: { n: number; pct: number } | null; deletes: { n: number; pct: number } | null } | { note: string };
  users: number | null; usersNote: string | null; usedBy: { id: string; name: string }[];
};

function firebaseLabel(state: State, d: FirebaseData): string {
  if (state === "ok") return `Reachable · ${d.latencyMs ?? "—"} ms`;
  if (state === "off") return "No Firestore database";
  return firestoreFailure({ kind: d.pingKind, reason: d.pingReason }).label;
}

export function firebaseRows(rows: DbRow[], book: AliasBook = EMPTY_BOOK): FirebaseView[] {
  return rows.map((r) => {
    const d = readData(firebaseData, r.data);
    const count = (n: number | null | undefined, max: number) => (n == null ? null : { n, pct: round2((n / max) * 100) });
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), projectId: r.externalId, account: r.account, stale: r.state === "unknown",
      health: known(r.state, firebaseLabel(r.state, d), d.lastGoodState),
      ops: d.opsError && d.reads == null ? { note: d.opsError } : { reads: count(d.reads, FIRESTORE_FREE.reads), writes: count(d.writes, FIRESTORE_FREE.writes), deletes: count(d.deletes, FIRESTORE_FREE.deletes) },
      users: d.authUsers ?? null, usersNote: d.authError ?? null, usedBy: r.usedBy,
    };
  });
}

function staleSub(rows: DbRow[], now: Date): string | null {
  if (!rows.length || !rows.every((r) => r.state === "unknown")) return null;
  const at = rows.map((r) => r.collectedAt).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
  return `API not responding${at ? ` · data from ${rel(at, now)}` : ""}`;
}

// Overview → status strip cells (mockup: "2 accounts · 1 paused", "ticketer is asleep · 41 of 100 compute hours used this month", "3 projects reachable").
export function supabaseCell(rows: DbRow[], now: Date): { state: State; sub: string; empty?: boolean } {
  if (!rows.length) return { state: "unknown", sub: "No projects watched yet", empty: true };
  const stale = staleSub(rows, now);
  if (stale) return { state: "unknown", sub: stale };
  const paused = rows.filter((r) => r.state === "paused").length;
  const sick = rows.filter((r) => r.state === "warn" || r.state === "err").length;
  const parts = [plural(new Set(rows.map((r) => r.account)).size, "account"), paused ? `${paused} paused` : null, sick ? `${sick} unhealthy` : null];
  return { state: worst(rows.map((r) => r.state)), sub: parts.filter(Boolean).join(" · ") };
}

export function neonCell(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): { state: State; sub: string; empty?: boolean } {
  if (!rows.length) return { state: "unknown", sub: "No projects watched yet", empty: true };
  const stale = staleSub(rows, now);
  if (stale) return { state: "unknown", sub: stale };
  const blocks = neonBlocks(rows, now, book);
  if (blocks.length === 1) {
    const b = blocks[0];
    // Plain words (D22): an idle compute "is asleep", and the figure says what it counts and over which period (the Neon
    // free plan's compute hours reset monthly, see neonBlocks' `resets`).
    const word = b.status.label === "Idle" ? "is asleep" : b.status.label.toLowerCase();
    return { state: rows[0].state, sub: `${b.alias} ${word}${b.cu ? ` · ${Math.round(b.cu.value)} of ${NEON_FREE.cuHours} compute hours used this month` : ""}` };
  }
  return { state: worst(rows.map((r) => r.state)), sub: `${plural(rows.length, "project")} · ${rows.filter((r) => r.state === "ok").length} active` };
}

export function firebaseCell(rows: DbRow[], now: Date): { state: State; sub: string; empty?: boolean } {
  if (!rows.length) return { state: "unknown", sub: "No projects watched yet", empty: true };
  const stale = staleSub(rows, now);
  if (stale) return { state: "unknown", sub: stale };
  const bad = rows.filter((r) => r.state !== "ok").length;
  return { state: worst(rows.map((r) => r.state)), sub: bad ? `${bad} of ${rows.length} unreachable` : `${plural(rows.length, "project")} reachable` };
}

// Overview: one warning per paused Supabase project, after the app banners (mockup). Databases by alias, the slot
// card's projects by their ids, an account label without its email (privacy).
export function dbBanners(rows: SupabaseView[], slots: SlotCard[], book: AliasBook = EMPTY_BOOK): ProblemBanner[] {
  return rows.filter((r) => r.paused && !r.stale).map((r) => {
    const apps = r.usedBy.map((a) => a.name);
    const who = apps.length ? `${apps.join(", ")} ${apps.length > 1 ? "get" : "gets"} errors until it's restored. ` : "";
    const card = slots.find((s) => s.account === r.account);
    const account = hideEmails(r.account);
    const active = card ? card.activeIds.map((id) => dbAlias(book, id)) : [];
    const slot = !card ? ""
      : card.left > 0 ? `Account ${account} has a free slot to restore it.`
      : `Account ${account} already uses both free slots${active.length ? ` (${active.join(", ")})` : ""}. Pause one of them first, or move ${r.alias} to an account with a free slot.`;
    return { key: `db-${r.id}`, tone: "warning" as const, title: `Supabase project ${r.alias} is paused`, body: hideEmails(`${who}${slot}`.trim()), action: { label: "Open Supabase", href: "/supabase" } };
  });
}
