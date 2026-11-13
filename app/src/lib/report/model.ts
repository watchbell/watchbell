import { type DayCount, uptimePct } from "@/lib/view/uptime";
import { monthDays, zoneDay } from "@/lib/zone-day";

// Watchbell 1.7 (spec §2.4, §5): the month of a client report as plain numbers, before any wording or drawing. Sites
// are known only by the display name the owner typed; nothing here carries a hostname or a monitor id onward.

export type DayTone = "ok" | "warn" | "down" | "none";
export type Ended = "resolved" | "open";

export type ReportInput = {
  month: string;
  zone: string;
  generatedAt: Date;
  sites: { monitorId: string; name: string; intervalS: number; firstDay: string | null; days: Map<string, DayCount>; p50ByDay: Map<string, number | null> }[];
  incidents: { monitorId: string; kind: "down" | "slow"; startedAt: Date; resolvedAt: Date | null; endedBy: Ended }[];
  deploys: { monitorId: string; ok: number; failed: number; firstDay: string | null }[];
  dataFrom: { uptime: string | null; updates: string | null };
};

export type IncidentLine = { at: Date; site: string; kind: "down" | "slow"; minutes: number; endedBy: Ended };

export type ReportModel = {
  month: string;
  days: { day: string; tone: DayTone }[];
  badDays: { day: string; tone: "warn" | "down"; lines: IncidentLine[] }[];
  summary: { uptimePct: number | null; p50Ms: number | null; updates: { ok: number; failed: number } };
  sites: { name: string; uptimePct: number | null; downMinutes: number; p50Ms: number | null; dataFrom: string | null }[];
  responseSeries: { name: string; values: (number | null)[] }[];
  updates: { name: string; ok: number; failed: number }[];
  incidents: IncidentLine[];
  dataFrom: { uptime: string | null; updates: string | null };
};

// A day is down from 5 minutes of failed checks (maintenance never counts: rollups keep it apart), a short outage below.
const DOWN_SECONDS = 300;
const RANK: Record<DayTone, number> = { none: 0, ok: 1, warn: 2, down: 3 };

export function dayTone(c: DayCount | undefined, intervalS: number): DayTone {
  if (!c || c.checks <= 0) return "none";
  const seconds = c.failures * intervalS;
  if (seconds >= DOWN_SECONDS) return "down";
  return c.failures > 0 ? "warn" : "ok";
}

const mean = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
};

export function buildReportModel(input: ReportInput): ReportModel {
  const days = monthDays(input.month);
  const first = days[0];
  const nameOf = new Map(input.sites.map((s) => [s.monitorId, s.name]));

  const tones = days.map((day) => {
    let tone: DayTone = "none";
    for (const s of input.sites) {
      const t = dayTone(s.days.get(day), s.intervalS);
      if (RANK[t] > RANK[tone]) tone = t;
    }
    return { day, tone };
  });

  const monthEnd = new Date(Date.parse(`${days[days.length - 1]}T23:59:59Z`));
  const incidents: IncidentLine[] = input.incidents
    .filter((i) => nameOf.has(i.monitorId))
    .map((i) => {
      const end = i.resolvedAt ?? (input.generatedAt < monthEnd ? input.generatedAt : monthEnd);
      return { at: i.startedAt, site: nameOf.get(i.monitorId) as string, kind: i.kind, minutes: Math.max(1, Math.round((end.getTime() - i.startedAt.getTime()) / 60_000)), endedBy: i.endedBy };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const badDays = tones
    .filter((t): t is { day: string; tone: "warn" | "down" } => t.tone === "warn" || t.tone === "down")
    .map((t) => ({ ...t, lines: incidents.filter((l) => zoneDay(l.at, input.zone) === t.day) }));

  const sites = input.sites.map((s) => {
    const list = days.map((d) => s.days.get(d));
    const failures = list.reduce((n, c) => n + (c?.failures ?? 0), 0);
    return {
      name: s.name,
      uptimePct: uptimePct(list),
      downMinutes: Math.round((failures * s.intervalS) / 60),
      p50Ms: mean(days.map((d) => s.p50ByDay.get(d))),
      dataFrom: s.firstDay && s.firstDay > first ? s.firstDay : null,
    };
  });

  const updates = input.sites.map((s) => {
    const d = input.deploys.find((x) => x.monitorId === s.monitorId);
    return { name: s.name, ok: d?.ok ?? 0, failed: d?.failed ?? 0 };
  });

  return {
    month: input.month,
    days: tones,
    badDays,
    summary: {
      uptimePct: uptimePct(input.sites.flatMap((s) => days.map((d) => s.days.get(d)))),
      p50Ms: mean(sites.map((s) => s.p50Ms)),
      updates: { ok: updates.reduce((n, u) => n + u.ok, 0), failed: updates.reduce((n, u) => n + u.failed, 0) },
    },
    sites,
    responseSeries: input.sites.map((s) => ({ name: s.name, values: days.map((d) => s.p50ByDay.get(d) ?? null) })),
    updates,
    incidents,
    dataFrom: input.dataFrom,
  };
}
