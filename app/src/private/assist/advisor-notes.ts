import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { settings } from "@/db/schema";
import { complete, consoleTarget } from "@/private/ai/gateway";
import { consoleSnapshot } from "@/private/console/snapshot";
import { appRefs, resolveApp } from "@/private/mcp/data";
import { insertNote } from "@/private/mcp/notes-db";
import {
  ADVISOR_RUNS_KEY, ADVISOR_SETTINGS_KEY, type AdvisorSettings, advisorPrompt, advisorWindow, parseAdvisorNotes, parseAdvisorSettings, pickAdvisorApps,
} from "./advisor-logic";

// The runner of advisor notes by the provider (owner 14 Oct). Scheduled from the per-minute collector (minuteSteps):
// a minute outside [07:00, 07:15) / [19:00, 19:15) WIB costs nothing; inside, the owner's setting is read, the default
// provider must resolve (else skip silently), and the window's marker in ops.settings is claimed in ONE conditional
// upsert BEFORE the provider is called, so concurrent collector runs never write twice. One provider call returns
// every note as JSON; valid ones go to ops.ai_notes through insertNote (source/client 'watchpost', the provider model).

export const ADVISOR_DEADLINE_MS = 40_000;
export const WATCHPOST = "watchpost";

export type AdvisorRun =
  | { status: "written"; count: number; model: string }
  | { status: "skipped"; reason: "outside-window" | "off" | "no-provider" | "already-ran" | "no-apps" | "no-valid-notes" };

type Row = Record<string, unknown>;

export async function readAdvisorSettings(): Promise<AdvisorSettings> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, ADVISOR_SETTINGS_KEY)).limit(1);
  return parseAdvisorSettings(row?.value);
}

export async function saveAdvisorSettings(v: AdvisorSettings, now: Date = new Date()): Promise<void> {
  await db().insert(settings).values({ key: ADVISOR_SETTINGS_KEY, value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: now } });
}

// true = this caller owns the window (no other run recorded it yet).
export async function claimWindow(window: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const res = await db().execute(sql`
    insert into ops.settings (key, value, created_at, updated_at)
    values (${ADVISOR_RUNS_KEY}, ${JSON.stringify({ window, at })}::jsonb, ${at}::timestamptz, ${at}::timestamptz)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      where ops.settings.value->>'window' is distinct from ${window}
    returning 1 as claimed`);
  return rowsOf<Row>(res).length === 1;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("advisor deadline")), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// `force` = the owner's Run now: no window, no marker, runs even when switched off.
export async function runAdvisorNotes(now: Date, opts: { force?: boolean; deadlineMs?: number } = {}): Promise<AdvisorRun> {
  const window = advisorWindow(now);
  if (!opts.force && !window) return { status: "skipped", reason: "outside-window" };
  const s = await readAdvisorSettings();
  if (!opts.force && !s.enabled) return { status: "skipped", reason: "off" };
  try {
    await consoleTarget(s.model ?? undefined);
  } catch {
    return { status: "skipped", reason: "no-provider" };
  }
  if (!opts.force && !(await claimWindow(window as string, now))) return { status: "skipped", reason: "already-ran" };
  const snap = await consoleSnapshot(now);
  const apps = pickAdvisorApps(snap);
  if (apps.length === 0) return { status: "skipped", reason: "no-apps" };
  const r = await withDeadline(complete(advisorPrompt(snap, apps), { ...(s.model ? { model: s.model } : {}), purpose: "summary", maxTokens: 1500, temperature: 0.2 }), opts.deadlineMs ?? ADVISOR_DEADLINE_MS);
  const notes = parseAdvisorNotes(r.text, apps);
  if (notes.length === 0) return { status: "skipped", reason: "no-valid-notes" };
  const refs = await appRefs();
  let count = 0;
  for (const n of notes) {
    const res = await insertNote(
      { title: n.title, body: n.body, severity: n.severity, appId: resolveApp(refs, n.app)?.id ?? null, model: r.model.slice(0, 120), client: WATCHPOST },
      null, WATCHPOST, now,
    );
    if (res.ok) count++;
  }
  return { status: "written", count, model: r.model };
}

// The per-minute step: never throws, never waits beyond its deadline, logs one short line when it did something.
export async function advisorMinuteStep(now: Date): Promise<void> {
  if (!advisorWindow(now)) return;
  try {
    const r = await runAdvisorNotes(now, { deadlineMs: ADVISOR_DEADLINE_MS });
    if (r.status === "written") console.log(`advisor notes: ${r.count} written (${r.model})`);
    else if (r.reason !== "already-ran" && r.reason !== "outside-window") console.log(`advisor notes: skipped (${r.reason})`);
  } catch (e) {
    console.warn("advisor notes failed:", e instanceof Error ? (e.message === "advisor deadline" ? "deadline" : e.name) : "unknown");
  }
}
