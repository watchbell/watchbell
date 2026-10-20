// R3 (Red Hat Insights Advisor, Backstage scorecards): daily hygiene items with a why, a fix and a link. Separate from
// alerts, never notified. Keys are stable, so a dismissal (30 days) follows the item, and a changed situation (another
// status code, another expiry date) is a new item.
import { dayMonth, TZ, wibDate } from "@/lib/time";

export type Rec = { key: string; severity: "warning" | "info"; appId: string | null; subject: string; title: string; why: string; fix: string; href: string };
export type AdvisorFacts = {
  now: Date;
  monitors: { id: string; appId: string; appName: string; path: string; kind: "http" | "heartbeat"; name: string | null; lastStatus: number | null; expectedStatus: number; paused: boolean; lastPingAt: Date | null; createdAt: Date }[];
  eol: { appId: string; appName: string; cycle: string; eolFrom: Date | null; latest: string | null }[] | null;
  headers: { appId: string; appName: string; missing: string[] }[] | null;
  dbs: { id: string; name: string; provider: string; accountId: string; accountLabel: string; state: string }[] | null;
  // Supabase free slots per account label (every project the token sees, the plan read from the org): used of total.
  slots: { account: string; used: number; total: number; planUnknown: boolean }[] | null;
  links: { appId: string; dbId: string }[] | null;
  accounts: { id: string; provider: string; label: string; expiresAt: Date | null; scopeNote: string | null }[];
};

export const COMEBACK_MS = 30 * 86_400_000;
export const MAX_RECS = 50;
const DAY = 86_400_000;
const longDay = (d: Date) => { const w = wibDate(d); return `${w.day} ${w.month} ${w.year}`; };
// The calendar day in WIB (YYYY-MM-DD), the same calendar the title uses.
const isoDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

export function recommendations(f: AdvisorFacts): Rec[] {
  const out: Rec[] = [];
  for (const e of f.eol ?? []) {
    if (!e.eolFrom || e.eolFrom.getTime() - f.now.getTime() > 30 * DAY) continue;
    const past = e.eolFrom.getTime() <= f.now.getTime();
    const major = e.latest?.split(".")[0];
    out.push({ key: `next-eol:${e.appId}:${e.cycle}`, severity: "warning", appId: e.appId, subject: e.appName,
      title: `Next.js ${e.cycle} ${past ? "reached" : "reaches"} end of life on ${longDay(e.eolFrom)}`,
      why: `No security fixes after that date.${e.latest ? ` Latest is ${e.latest}.` : ""}`, fix: major ? `Upgrade to Next.js ${major}.` : "Upgrade Next.js.", href: "https://endoflife.date/nextjs" });
  }
  for (const m of f.monitors) {
    if (m.paused) continue; // the owner paused it on purpose: a heartbeat's silence or a stale status isn't news
    if (m.kind === "heartbeat" && !m.lastPingAt && f.now.getTime() - m.createdAt.getTime() > DAY) {
      out.push({ key: `hb-silent:${m.id}`, severity: "warning", appId: m.appId, subject: m.appName, title: `${m.name ?? "A heartbeat"} has never pinged`,
        why: "It was added more than a day ago and no job has called its URL.", fix: "Add the ping to the job, or delete the monitor.", href: "/uptime" });
    }
    if (m.kind === "http" && m.path === "/" && m.expectedStatus === 200 && m.lastStatus !== null && [401, 403, 404].includes(m.lastStatus)) {
      out.push({ key: `monitor-root:${m.id}:${m.lastStatus}`, severity: "info", appId: m.appId, subject: m.appName, title: `The monitor on / answers ${m.lastStatus}`,
        why: `A login or missing page answering ${m.lastStatus} makes the monitor look down.`, fix: `Point the monitor at a public health route, or expect ${m.lastStatus}.`, href: "/uptime" });
    }
  }
  for (const h of f.headers ?? []) {
    if (!h.missing.length) continue;
    const list = [...h.missing].sort();
    out.push({ key: `headers:${h.appId}:${list.join(",")}`, severity: "info", appId: h.appId, subject: h.appName, title: `Missing security headers: ${list.join(", ")}`,
      why: "Browsers use them to block clickjacking, sniffing and downgrade attacks.", fix: "Add them in next.config headers().", href: "https://developer.mozilla.org/en-US/observatory" });
  }
  for (const sl of f.slots ?? []) {
    if (sl.used < sl.total) continue;
    out.push({ key: `no-slot:${sl.account}`, severity: "warning", appId: null, subject: `supabase · ${sl.account}`, title: `Account ${sl.account} has no free slot`,
      why: sl.planUnknown ? "Two projects are active. If this account is on the free plan (it couldn't be read), a paused one can't be restored here." : "Both free projects are active, so a paused one can't be restored here.",
      fix: "Pause one project, or move one to another account.", href: "/supabase" });
  }
  if (f.dbs) {
    if (f.links) {
      const linked = new Set(f.links.map((l) => l.dbId));
      for (const d of f.dbs.filter((x) => !linked.has(x.id))) {
        out.push({ key: `db-unlinked:${d.id}`, severity: "info", appId: null, subject: d.name, title: "Database isn't linked to any app",
          why: "Topology and the app status can't use it.", fix: "Link it from the app page.", href: "/apps" });
      }
    }
  }
  for (const a of f.accounts) {
    if (a.provider === "supabase" && a.scopeNote && /all[- ]access/i.test(a.scopeNote)) {
      out.push({ key: `broad-cred:${a.id}`, severity: "info", appId: null, subject: `supabase · ${a.label}`, title: `${a.label} uses an all-access token`,
        why: "The console only reads; a broader token is a bigger risk if it ever leaks.", fix: "Replace it with a read-only token in Connections, then revoke the old one in Supabase.", href: "/connections" });
    }
  }
  for (const a of f.accounts) {
    if (!a.expiresAt) continue;
    const left = a.expiresAt.getTime() - f.now.getTime();
    if (left >= 14 * DAY && left <= 60 * DAY) {
      out.push({ key: `cred-60:${a.id}:${isoDay(a.expiresAt)}`, severity: "info", appId: null, subject: `${a.provider} · ${a.label}`, title: `The ${a.provider} credential ${a.label} expires on ${dayMonth(a.expiresAt)}`,
        why: "An expired credential stops every reading from that account.", fix: "Create a new one and use Replace credential in Connections.", href: "/connections" });
    }
  }
  const rank = (r: Rec) => (r.severity === "warning" ? 0 : 1);
  return out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r).slice(0, MAX_RECS);
}

export function visible(recs: Rec[], dismissed: Map<string, Date>, now: Date): Rec[] {
  return recs.filter((r) => {
    const at = dismissed.get(r.key);
    return !at || now.getTime() - at.getTime() >= COMEBACK_MS;
  });
}
