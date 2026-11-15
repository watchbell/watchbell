import { type DayCount, uptimePct } from "@/lib/view/uptime";
import { monthDays, zoneDay, zoneMidnight } from "@/lib/zone-day";

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
// 1.7.1 (review M-3): page 1 explains each bad day per site: how long it couldn't be opened and whether it was slow.
export type DayLine = { day: string; site: string; tone: "warn" | "down"; downMinutes: number; slow: boolean };

export type ReportModel = {
  month: string;
  days: { day: string; tone: DayTone }[];
  badDays: { day: string; tone: "warn" | "down"; lines: IncidentLine[] }[];
  dayLines: DayLine[];
  intervals: number[];
  summary: { uptimePct: number | null; p50Ms: number | null; updates: { ok: number; failed: number }; dataFrom: string | null };
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

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

export function buildReportModel(input: ReportInput): ReportModel {
  const days = monthDays(input.month);
  const first = days[0];
  const nameOf = new Map(input.sites.map((s) => [s.monitorId, s.name]));
  // Review M-1: the month ends at midnight in the install's zone, not in UTC.
  const monthEnd = zoneMidnight(`${nextMonth(input.month)}-01`, input.zone);
  const endOf = (i: ReportInput["incidents"][number]) => i.resolvedAt ?? (input.generatedAt < monthEnd ? input.generatedAt : monthEnd);

  // Review M-2: the zone days a slow incident touched, per site (a slow day is amber when it is otherwise all up).
  const slowDays = new Map<string, Set<string>>();
  for (const i of input.incidents) {
    if (i.kind !== "slow" || !nameOf.has(i.monitorId)) continue;
    const set = slowDays.get(i.monitorId) ?? new Set<string>();
    const last = zoneDay(new Date(Math.max(i.startedAt.getTime(), endOf(i).getTime() - 1)), input.zone);
    for (let d = zoneDay(i.startedAt, input.zone); d <= last; d = zoneDay(new Date(zoneMidnight(d, input.zone).getTime() + 36 * 3_600_000), input.zone)) set.add(d);
    slowDays.set(i.monitorId, set);
  }

  const tones = days.map((day) => {
    let tone: DayTone = "none";
    for (const s of input.sites) {
      let t = dayTone(s.days.get(day), s.intervalS);
      if (t === "ok" && slowDays.get(s.monitorId)?.has(day)) t = "warn";
      if (RANK[t] > RANK[tone]) tone = t;
    }
    return { day, tone };
  });

  const incidents: IncidentLine[] = input.incidents
    .filter((i) => nameOf.has(i.monitorId))
    .map((i) => ({ at: i.startedAt, site: nameOf.get(i.monitorId) as string, kind: i.kind, minutes: Math.max(1, Math.round((endOf(i).getTime() - i.startedAt.getTime()) / 60_000)), endedBy: i.endedBy }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const dayLines: DayLine[] = days.flatMap((day) => input.sites.flatMap((s): DayLine[] => {
    const c = s.days.get(day);
    const failures = c && c.checks > 0 ? c.failures : 0;
    const slow = slowDays.get(s.monitorId)?.has(day) ?? false;
    if (!failures && !slow) return [];
    return [{ day, site: s.name, tone: failures * s.intervalS >= DOWN_SECONDS ? "down" : "warn", downMinutes: failures ? Math.max(1, Math.round((failures * s.intervalS) / 60)) : 0, slow }];
  }));

  const starts = input.sites.map((s) => s.firstDay).filter((d): d is string => d !== null).sort();
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
    dayLines,
    intervals: [...new Set(input.sites.map((s) => s.intervalS))].sort((a, b) => a - b),
    summary: {
      uptimePct: uptimePct(input.sites.flatMap((s) => days.map((d) => s.days.get(d)))),
      p50Ms: mean(sites.map((s) => s.p50Ms)),
      updates: { ok: updates.reduce((n, u) => n + u.ok, 0), failed: updates.reduce((n, u) => n + u.failed, 0) },
      // Review M-6: nothing was measured before the earliest site's first day.
      dataFrom: starts.length && starts[0] > first ? starts[0] : null,
    },
    sites,
    responseSeries: input.sites.map((s) => ({ name: s.name, values: days.map((d) => s.p50ByDay.get(d) ?? null) })),
    updates,
    incidents,
    dataFrom: input.dataFrom,
  };
}
