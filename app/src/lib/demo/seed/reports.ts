import { deployDays, reports, reportSends, reportSites } from "@/db/report-schema";
import { sql } from "drizzle-orm";
import { settings, workspaces } from "@/db/schema";
import { BRAND_SETTING } from "@/lib/branding";
import { summarizeDeploys } from "@/lib/collector/deploy-days";
import { timeZone } from "@/lib/time";
import { zoneDay } from "@/lib/zone-day";
import { deploymentRows, type SeededApps } from "./apps";
import type { SeedCtx } from "./context";
import type { SeededUptime } from "./uptime";

// Watchbell 1.7: the demo's monthly client reports and brand, with made-up names (.example addresses only). Last
// month's automatic send shows as sent; nothing is ever emailed from the demo (lib/notify/resend.ts refuses).

const KOPI_WS = "00000000-0000-4000-8000-0000000000b1";
const NORTH_WS = "00000000-0000-4000-8000-0000000000b2";

const prevMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export async function seedReports(ctx: SeedCtx, apps: SeededApps, uptime: SeededUptime): Promise<void> {
  const { db, now } = ctx;
  const zone = timeZone();
  await db.insert(settings).values({
    key: BRAND_SETTING,
    value: { name: "Studio Nusa", accent: "#0f766e", senderName: "Studio Nusa", publicUrl: null, poweredBy: true, hasLogo: false },
    createdAt: now, updatedAt: now, // the seed's clock, so a seed always gives the same rows
  });

  // The daily deploy summary, as the daily job would have kept it from the seeded deployments.
  const rows = deploymentRows(ctx, apps.apps).map((d) => ({ resourceId: d.resourceId, state: d.state, createdAtProvider: d.createdAtProvider as Date }));
  const days = summarizeDeploys(rows, zone);
  if (days.length) await db.insert(deployDays).values(days);

  const http = uptime.monitors;
  // Watchbell 1.8: the two made-up clients as workspaces (fixed ids, the seed's clock); Personal comes from the migration.
  await db.execute(sql`update ops.workspaces set created_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz`);
  await db.insert(workspaces).values([
    { id: KOPI_WS, name: "Kopi Senja", position: 1, createdAt: now, updatedAt: now },
    { id: NORTH_WS, name: "Northwind Studio", position: 2, createdAt: now, updatedAt: now },
  ]);
  if (!http.length) return;
  // Review M-10 (1.7.1): fixed ids and the seed's clock, so a seed always gives the same rows.
  const [kopi, north] = await db.insert(reports).values([
    {
      id: "00000000-0000-4000-8000-0000000000a1", createdAt: now, updatedAt: now, workspaceId: KOPI_WS,
      clientName: "Kopi Senja", lang: "id", recipients: ["pemilik@kopi-senja.example"], autoSend: true, sender: "resend",
      note: "Gambar toko dipindah ke penyimpanan yang lebih cepat; halaman produk sekarang lebih ringan.", emailOpening: "Halo Bu Rina,",
    },
    { id: "00000000-0000-4000-8000-0000000000a2", createdAt: now, updatedAt: now, workspaceId: NORTH_WS, clientName: "Northwind Studio", lang: "en", recipients: ["ops@northwind.example"], autoSend: false, sender: null },
  ]).returning({ id: reports.id });
  const names = ["Toko utama", "Toko online", "Admin"];
  await db.insert(reportSites).values([
    ...http.slice(0, 3).map((m, i) => ({ reportId: kopi.id, monitorId: m.id, displayName: names[i], position: i })),
    { reportId: north.id, monitorId: http[http.length - 1].id, displayName: "Website", position: 0 },
  ]);
  // Each client's apps (and their domains) sit in its workspace; everything else stays in Personal.
  const place = async (ws: string, appIds: string[]) => {
    if (!appIds.length) return;
    const list = sql.join(appIds.map((id) => sql`${id}::uuid`), sql`, `);
    await db.execute(sql`update ops.resources set workspace_id = ${ws}::uuid where id in (${list}) or parent_id in (${list})`);
  };
  await place(KOPI_WS, [...new Set(http.slice(0, 3).map((m) => m.appId))]);
  await place(NORTH_WS, [http[http.length - 1].appId].filter((id) => !http.slice(0, 3).some((m) => m.appId === id)));
  const last = prevMonth(zoneDay(now, zone).slice(0, 7));
  await db.insert(reportSends).values({ reportId: kopi.id, month: last, status: "sent", attempts: 1, sentAt: new Date(now.getTime() - 3 * 86_400_000) });
}
