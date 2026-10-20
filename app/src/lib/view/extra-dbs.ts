import { z } from "zod";
import { countText, D1_FREE, d1Shares, type Share, TURSO_FREE, tursoShares, UPSTASH_FREE, upstashShares } from "@/lib/databases/extra";
import { d1Data, readData, tursoData, upstashData } from "@/lib/databases/snapshot-data";
import type { DbRow } from "@/lib/data/databases-db";
import { ANALYTICS_PERMISSION, D1_PERMISSION } from "@/lib/providers/cloudflare-d1";
import type { State } from "@/lib/status";
import { type AliasBook, dbAlias, EMPTY_BOOK } from "./display-name";
import { bytesText } from "./databases";
import { rel } from "./format";
import { STATE_WORD } from "./labels";

// Stage 8: the Turso, Upstash and Cloudflare D1 pages. Pure: the pages pass in the watched rows (listDatabases).

export type Shown = { state: State; label: string };
export type Meter = { label: string; value: string; of: string; pct: number | null };
export type ExtraView = {
  id: string; name: string; alias: string; account: string; sub: string; status: Shown; stale: boolean;
  meters: Meter[]; note: string | null; asOf: string | null; usedBy: { id: string; name: string }[];
};

const known = (state: State, label: string, lastGood: string | undefined): Shown =>
  state !== "unknown" ? { state, label } : { state: "unknown", label: lastGood && lastGood in STATE_WORD ? `Unknown · last seen ${STATE_WORD[lastGood as State]}` : "Unknown" };

const meter = (s: Share | undefined, value: string, of: string, label: string): Meter => ({ label, value, of, pct: s?.pct ?? null });
const find = (xs: Share[], label: string) => xs.find((x) => x.label === label);
const DASH = "—";

export const NOT_ON_FREE = "not readable on Free";

export function tursoViews(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): ExtraView[] {
  return rows.map((r) => {
    const d = readData(tursoData, r.data);
    const sh = tursoShares(d, now);
    const has = sh.length > 0;
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), account: r.account, usedBy: r.usedBy, stale: r.state === "unknown",
      sub: [d.group ? `group ${d.group}` : null, d.primaryRegion, d.plan ? `plan ${d.plan}` : null].filter(Boolean).join(" · "),
      status: known(r.state, r.state === "ok" ? "Available" : r.state === "err" ? (d.blockReads ? "Reads blocked" : "Writes blocked") : r.state === "off" ? "Not found" : "Unknown", d.lastGoodState),
      meters: [
        meter(find(sh, "Rows read"), has && d.orgRowsRead != null ? countText(d.orgRowsRead) : DASH, `of ${countText(TURSO_FREE.rowsRead)} this month (org)`, "Rows read"),
        meter(find(sh, "Rows written"), has && d.orgRowsWritten != null ? countText(d.orgRowsWritten) : DASH, `of ${countText(TURSO_FREE.rowsWritten)} this month (org)`, "Rows written"),
        meter(find(sh, "Storage"), has && d.orgStorageBytes != null ? bytesText(d.orgStorageBytes) : DASH, "of 5 GB (org)", "Storage"),
      ],
      note: d.usageError ?? (has && d.rowsRead != null ? `This database: ${countText(d.rowsRead)} rows read, ${countText(d.rowsWritten ?? 0)} written, ${bytesText(d.storageBytes)} stored this month.` : null),
      asOf: d.usageAt ? rel(new Date(d.usageAt), now) : null,
    };
  });
}

export function upstashViews(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): ExtraView[] {
  return rows.map((r) => {
    const d = readData(upstashData, r.data);
    const sh = upstashShares(d, now);
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), account: r.account, usedBy: r.usedBy, stale: r.state === "unknown",
      sub: [d.region, d.type ? `${d.type} plan` : null].filter(Boolean).join(" · "),
      status: known(r.state, r.state === "ok" ? "Active" : r.state === "err" ? "Suspended" : r.state === "off" ? "Not found" : d.status ? `State: ${d.status}` : "Unknown", d.lastGoodState),
      meters: [
        meter(find(sh, "Commands"), find(sh, "Commands") && d.monthlyRequests != null ? countText(d.monthlyRequests) : DASH, `of ${countText(UPSTASH_FREE.monthlyCommands)} this month`, "Commands"),
        meter(find(sh, "Data size"), d.storageBytes != null ? bytesText(d.storageBytes) : DASH, "of 250 MB", "Data size"),
        meter(find(sh, "Bandwidth"), find(sh, "Bandwidth") && d.monthlyBandwidthBytes != null ? bytesText(d.monthlyBandwidthBytes) : DASH, "of 10 GB this month", "Bandwidth"),
      ],
      note: d.statsError ?? (d.dailyCommands != null ? `${countText(d.dailyCommands)} commands today.` : null),
      asOf: d.statsAt ? rel(new Date(d.statsAt), now) : null,
    };
  });
}

export type D1View = ExtraView & { tables: string; size: string };

export function d1Views(rows: DbRow[], now: Date, book: AliasBook = EMPTY_BOOK): D1View[] {
  return rows.map((r) => {
    const d = readData(d1Data, r.data);
    const sh = d1Shares(d, now);
    const today = !!find(sh, "Rows read today");
    return {
      id: r.id, name: r.name, alias: dbAlias(book, r.id), account: r.account, usedBy: r.usedBy, stale: r.state === "unknown",
      sub: d.readReplication === "auto" ? "read replication on" : "",
      status: known(r.state, r.state === "ok" ? "Available" : r.state === "err" ? "Daily row limit reached" : r.state === "off" ? "Not found" : "Unknown", d.lastGoodState),
      size: d.sizeBytes != null ? bytesText(d.sizeBytes) : DASH,
      // Cloudflare marks num_tables deprecated ("no longer accurate"), so it is shown as approximate.
      tables: d.numTables != null ? `~${d.numTables}` : DASH,
      meters: [
        meter(find(sh, "Rows read today"), today && d.accountRowsRead != null ? countText(d.accountRowsRead) : DASH, `of ${countText(D1_FREE.rowsReadPerDay)} today (account)`, "Rows read"),
        meter(find(sh, "Rows written today"), today && d.accountRowsWritten != null ? countText(d.accountRowsWritten) : DASH, `of ${countText(D1_FREE.rowsWrittenPerDay)} today (account)`, "Rows written"),
        meter(find(sh, "Size"), d.sizeBytes != null ? bytesText(d.sizeBytes) : DASH, "of 500 MB", "Size"),
      ],
      note: d.usageError ?? d.detailsError ?? (today && d.rowsRead != null ? `This database today: ${countText(d.rowsRead)} rows read, ${countText(d.rowsWritten ?? 0)} written.` : null),
      asOf: d.usageAt ? rel(new Date(d.usageAt), now) : d.detailsAt ? rel(new Date(d.detailsAt), now) : null,
    };
  });
}

// ---- D1 permission notes, per Cloudflare account (written by the hourly task, settings key d1.access) ----

export const D1_ACCESS_KEY = "d1.access";
const accessEntry = z.object({
  d1: z.enum(["ok", "missing", "error"]), analytics: z.enum(["ok", "missing", "error"]).nullable(), at: z.string(), note: z.string().nullable(),
});
export type D1Access = Record<string, z.infer<typeof accessEntry>>;

export function parseD1Access(raw: unknown): D1Access {
  const p = z.record(z.string(), accessEntry).safeParse(raw);
  return p.success ? p.data : {};
}

// What the D1 page says under a Cloudflare account. null: nothing to add.
export function d1AccessNote(a: D1Access[string] | undefined): { tone: "warn" | "info"; text: string } | null {
  if (!a) return { tone: "info", text: "Not read yet: the D1 read runs hourly at :16." };
  if (a.note) return { tone: "warn", text: a.note };
  if (a.d1 === "missing") return { tone: "warn", text: `The Cloudflare token can't list D1 databases. Edit the token and add "${D1_PERMISSION}".` };
  if (a.d1 === "error") return { tone: "warn", text: "Cloudflare didn't answer the D1 list last time. It is retried hourly." };
  if (a.analytics === "missing") return { tone: "info", text: `Rows read and written need "${ANALYTICS_PERMISSION}" on the token. Size is read without it.` };
  return null;
}
