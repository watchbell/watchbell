import { z } from "zod";
import { dayKey, zonedParts } from "@/lib/time";
import type { ConsoleSnapshot } from "@/private/console/types";
import { ALWAYS_APP } from "./advisor-config";
import { type ChatMessage, guard, SYSTEM_PROMPT } from "./prompts";

// Advisor notes by the owner's provider (owner 14 Oct; replaces the VM's 07:00/19:00 WIB cron). Pure: the schedule
// window, which apps get a note, the prompt, the answer's validation and the owner's setting. The runner is
// advisor-notes.ts.

export const ADVISOR_SETTINGS_KEY = "ai.advisorNotes"; // { enabled: boolean, model: string | null }
export const ADVISOR_RUNS_KEY = "ai.advisorRuns"; // { window: "2026-10-14T07", at: ISO } (the marker)
export const MAX_OTHER_APPS = 3;
export const MAX_NOTES = 4;
export const TITLE_MAX = 79; // "< 80 chars"
export const BODY_MAX = 600;
export const WINDOW_MINUTES = 15;

export type AdvisorSettings = { enabled: boolean; model: string | null };
export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = { enabled: true, model: null };

export function parseAdvisorSettings(v: unknown): AdvisorSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_ADVISOR_SETTINGS;
  const o = v as Record<string, unknown>;
  const model = typeof o.model === "string" && o.model.trim() && o.model.length <= 200 ? o.model.trim() : null;
  return { enabled: o.enabled !== false, model };
}

// The run window: [07:00, 07:15) or [19:00, 19:15) on the local clock (lib/time.ts; WIB by default), as
// "YYYY-MM-DDTHH" in local time; null outside both.
export function advisorWindow(now: Date): string | null {
  const { hour: h, minute: m } = zonedParts(now);
  if ((h !== 7 && h !== 19) || m >= WINDOW_MINUTES) return null;
  return `${dayKey(now)}T${String(h).padStart(2, "0")}`;
}

type Alert = { app?: unknown; severity?: unknown; title?: unknown; message?: unknown };
type Monitor = { app?: unknown; state?: unknown; path?: unknown };

const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

// The always-included app (ALWAYS_APP, when there is one and it is watched), plus up to 3 other apps with something to say, most urgent first: down,
// an open alert, a failing/degraded monitor or degraded state, then a warn/crit Advisor recommendation.
export function pickAdvisorApps(s: ConsoleSnapshot): string[] {
  const names = s.apps.map((a) => a.id);
  const score = new Map<string, number>();
  const bump = (name: unknown, n: number) => {
    const real = names.find((x) => x.toLowerCase() === lower(name));
    if (real) score.set(real, Math.max(score.get(real) ?? 0, n));
  };
  for (const a of s.apps) {
    if (a.state === "down") bump(a.id, 4);
    else if (a.state === "degraded") bump(a.id, 2);
  }
  for (const al of (s.alerts.items ?? []) as Alert[]) bump(al.app, 3);
  for (const m of (s.monitors.items ?? []) as Monitor[]) if (m.state === "down" || m.state === "degraded") bump(m.app, 2);
  for (const r of s.advisor ?? []) if (r.severity === "warn" || r.severity === "crit" || r.severity === "critical" || r.severity === "warning") bump(r.app, 1);
  const always = ALWAYS_APP ? names.find((n) => n.toLowerCase() === ALWAYS_APP) : undefined;
  const others = [...score.entries()].filter(([n]) => n !== always).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_OTHER_APPS).map(([n]) => n);
  return [...(always ? [always] : []), ...others];
}

// One call for every note: the picked apps' scrubbed data (snapshot apps, their alerts, monitors and recommendations),
// every string through guard() again.
export function advisorPrompt(s: ConsoleSnapshot, apps: string[]): ChatMessage[] {
  const is = (v: unknown) => apps.some((a) => a.toLowerCase() === lower(v));
  const data = {
    generatedAt: s.generatedAt,
    apps: s.apps.filter((a) => is(a.id)).map((a) => ({
      app: guard(a.id, 80), state: a.state, uptime30d: a.uptime30d, database: a.database ? guard(a.database, 40) : null, lastDeploy: a.lastDeploy ? guard(a.lastDeploy, 40) : null,
      problems: a.problems.slice(0, 8).map((p) => ({ kind: guard(p.kind, 30), where: guard(p.where, 120), what: guard(p.what), fix: p.fix ? guard(p.fix) : null })),
    })),
    alerts: ((s.alerts.items ?? []) as Alert[]).filter((a) => is(a.app)).slice(0, 12).map((a) => ({ app: guard(a.app, 80), severity: guard(a.severity, 20), title: guard(a.title), message: guard(a.message) })),
    monitors: ((s.monitors.items ?? []) as Monitor[]).filter((m) => is(m.app)).slice(0, 12).map((m) => ({ app: guard(m.app, 80), state: guard(m.state, 20), path: guard(m.path, 120) })),
    recommendations: (s.advisor ?? []).filter((r) => is(r.app)).slice(0, 12).map((r) => ({ app: guard(r.app, 80), severity: guard(r.severity, 20), title: guard(r.title) })),
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Write one short advisor note for each of these apps: ${apps.map((a) => guard(a, 80)).join(", ")}.`,
        'Answer with JSON only, no prose and no code fence: {"notes":[{"app":"<app name as given>","severity":"info|warn|crit","title":"<under 80 characters>","body":"<at most 4 short sentences in English with one concrete suggestion>"}]}.',
        "Use only the data below. Never include secrets, keys, email addresses, hostnames or URLs. Severity: crit when the app is down or has a critical alert, warn for anything else wrong, info when all is well.",
        "",
        JSON.stringify(data),
      ].join("\n"),
    },
  ];
}

const Note = z.object({
  app: z.string().trim().min(1).max(80),
  severity: z.enum(["info", "warn", "crit"]),
  title: z.string().trim().min(3).max(TITLE_MAX),
  body: z.string().trim().min(10).max(BODY_MAX),
});
export type AdvisorNote = z.infer<typeof Note>;

const HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|dev|id|co|xyz|cloud|site|me|ai)\b/i;
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 0).length;

// Extracts the JSON (a stray code fence or prose around it is tolerated), validates each note and drops the invalid
// ones: unknown app, a second note for the same app, a long title, more than 4 sentences, anything that looks like a
// URL, host, email or key. At most 4.
export function parseAdvisorNotes(text: string, apps: string[]): AdvisorNote[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let json: unknown;
  try { json = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const list = (json as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) return [];
  const out: AdvisorNote[] = [];
  for (const raw of list.slice(0, 20)) {
    const p = Note.safeParse(raw);
    if (!p.success) continue;
    const app = apps.find((a) => a.toLowerCase() === p.data.app.toLowerCase());
    if (!app || out.some((n) => n.app === app)) continue;
    const { title, body } = p.data;
    if (sentences(body) > 4) continue;
    const both = `${title} ${body}`;
    if (guard(both, 10_000) !== both.replace(/\s+/g, " ").trim() || HOST.test(both)) continue; // a URL, key shape, "@" or db string
    out.push({ app, severity: p.data.severity, title, body });
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}
