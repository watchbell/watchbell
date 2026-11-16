import type { Metadata } from "next";
import { brandStyle, consoleMetadata, DEFAULT_BRAND, displayName } from "@/lib/branding";
import { readBrand } from "@/lib/data/branding-db";
import { cookies } from "next/headers";
import { Shell } from "@/components/shell/shell";
import { TimeZoneSync } from "@/components/time-zone-sync";
import { requirePageMember } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { collectorStaleLimit } from "@/lib/collector/last-run";
import { lastCollectorRunAt } from "@/lib/collector/run";
import { readUpdateNotice } from "@/lib/collector/self-update";
import { outboundLinks } from "@/lib/demo/links";
import { consoleVersion, runningVersion } from "@/lib/self-update";
import { UpdateBanner } from "./update-banner";
import { openAlertCount } from "@/lib/data/alerts-db";
import { aliasBook } from "@/lib/data/cached";
import { sectionState } from "@/lib/data/sections-db";
import { isDemo, mode } from "@/lib/mode";
import { timeZone } from "@/lib/time";
import { EMPTY_BOOK, SHOT_COOKIE } from "@/lib/view/display-name";
import { currentWorkspace } from "@/lib/workspace/current";
import { soft } from "@/lib/soft";

// Watchbell 1.7: the browser tab names the brand (nothing changes without one).
export async function generateMetadata(): Promise<Metadata> {
  return consoleMetadata(await readBrand().catch(() => DEFAULT_BRAND));
}

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  // Demo: the visitor's database first, so "busy" shows as itself (lib/demo/facade.ts openDemoDb).
  if (isDemo()) await (await import("@/lib/demo/facade")).openDemoDb();
  const member = await requirePageMember();
  const now = new Date();
  // The bell and the nav pill follow the 60 s refresh: this layout renders again on every router.refresh(). The two
  // reads are independent, so they go out together (perf P4).
  // The db-a, db-b … letters (privacy) come from a cached read; without them every database shows "db-?", never its name.
  // Screenshot mode is a per-browser cookie (components/alias.tsx), read here so the page is masked from the first paint.
  // Watchbell 1.2: the sections that are on (lib/sections.ts); unreadable means every section, so nothing disappears.
  // 1.2.3: self-hosted, the owner sees a newer npm version or What's new after an update (null otherwise).
  const [last, staleMs, alerts, book, jar, sections, notice, brand, ws] = await Promise.all([
    soft(lastCollectorRunAt(), null, "last collector run"), soft(collectorStaleLimit(), undefined, "collector stale limit"), soft<number | null>(openAlertCount(), null, "open alert count"), aliasBook().catch(() => EMPTY_BOOK), cookies(),
    sectionState().then((s) => s.on).catch(() => undefined),
    member.role === "owner" ? readUpdateNotice().catch(() => null) : null,
    // Watchbell 1.7: the owner's brand (Settings › Branding) in the sidebar and the accent colour.
    readBrand().catch(() => DEFAULT_BRAND),
    // Watchbell 1.8: the workspace shown (a cookie) and the list for the switcher; the pages share this read.
    currentWorkspace().catch(() => ({ id: null, list: [] })),
  ]);
  const style = brandStyle(brand);
  const shot = jar.get(SHOT_COOKIE)?.value === "1";
  // 5c (R2): the private feature's nav and palette entries reach owners only; others never get them in the payload.
  const ext = member.role === "owner" ? { nav: extensions.nav, palette: extensions.palette, office: extensions.office } : { nav: [], palette: [] };
  // Self-host accounts have a password of their own to change (/account/password); cloud sign-in is by email link.
  const user = mode() === "selfhost" ? { email: member.email, role: member.role, hasPassword: true } : { email: member.email, role: member.role };
  // Client components format times too: they get the server's zone first (lib/time.ts, WATCHBELL_TIMEZONE).
  return (
    <>
      <TimeZoneSync zone={timeZone()} />
      {style && <style>{style}</style>}
      <Shell user={user} collector={{ lastRunAt: last?.toISOString() ?? null, now: now.getTime(), demo: isDemo(), staleMs }} alerts={alerts} book={book} shot={shot} ext={ext} sections={sections} selfhost={mode() !== "cloud"} version={consoleVersion(runningVersion(), outboundLinks())} brand={{ name: displayName(brand), hasLogo: brand.hasLogo, logoVersion: brand.logoVersion ?? null }} workspace={{ list: ws.list.map((w) => ({ id: w.id, name: w.name })), current: ws.id }}><UpdateBanner notice={notice} />{children}</Shell>
    </>
  );
}
