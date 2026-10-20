import { cookies } from "next/headers";
import { Shell } from "@/components/shell/shell";
import { TimeZoneSync } from "@/components/time-zone-sync";
import { requirePageMember } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { lastCollectorRunAt } from "@/lib/collector/run";
import { openAlertCount } from "@/lib/data/alerts-db";
import { aliasBook } from "@/lib/data/cached";
import { isDemo, mode } from "@/lib/mode";
import { timeZone } from "@/lib/time";
import { EMPTY_BOOK, SHOT_COOKIE } from "@/lib/view/display-name";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  // Demo: the visitor's database first, so "busy" shows as itself (lib/demo/facade.ts openDemoDb).
  if (isDemo()) await (await import("@/lib/demo/facade")).openDemoDb();
  const member = await requirePageMember();
  const now = new Date();
  // The bell and the nav pill follow the 60 s refresh: this layout renders again on every router.refresh(). The two
  // reads are independent, so they go out together (perf P4).
  // The db-a, db-b … letters (privacy) come from a cached read; without them every database shows "db-?", never its name.
  // Screenshot mode is a per-browser cookie (components/alias.tsx), read here so the page is masked from the first paint.
  const [last, alerts, book, jar] = await Promise.all([lastCollectorRunAt().catch(() => null), openAlertCount().catch(() => 0), aliasBook().catch(() => EMPTY_BOOK), cookies()]);
  const shot = jar.get(SHOT_COOKIE)?.value === "1";
  // 5c (R2): the private feature's nav and palette entries reach owners only; others never get them in the payload.
  const ext = member.role === "owner" ? { nav: extensions.nav, palette: extensions.palette, office: extensions.office } : { nav: [], palette: [] };
  // Self-host accounts have a password of their own to change (/account/password); cloud sign-in is by email link.
  const user = mode() === "selfhost" ? { email: member.email, role: member.role, hasPassword: true } : { email: member.email, role: member.role };
  // Client components format times too: they get the server's zone first (lib/time.ts, WATCHBELL_TIMEZONE).
  return (
    <>
      <TimeZoneSync zone={timeZone()} />
      <Shell user={user} collector={{ lastRunAt: last?.toISOString() ?? null, now: now.getTime(), demo: isDemo() }} alerts={alerts} book={book} shot={shot} ext={ext}>{children}</Shell>
    </>
  );
}
