import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { ACTIONS, type AutoRun, type ProposalAction } from "./proposals-types";

// Stage 9 slice 1: the office auto-run setting (ops.settings "office.autoRun", JSON { kind: boolean }). Which SAFE action
// kinds an officer's proposal may run without asking. All off by default; a risky kind is always false, on read and on
// write, whatever is stored (a hand-edited row can't switch a redeploy on). Changes are audited like the other Settings
// edits (Events, type action, with the acting user).

export const AUTO_RUN_SETTING = "office.autoRun";
export const ACTION_KINDS = Object.keys(ACTIONS) as ProposalAction[];
export const SAFE_KINDS = ACTION_KINDS.filter((k) => ACTIONS[k].risk === "safe");

export const AUTO_RUN_OFF: AutoRun = Object.fromEntries(ACTION_KINDS.map((k) => [k, false])) as AutoRun;

// Pure: whatever is stored → a full AutoRun. Missing, not an object, unknown keys or non-boolean values → false.
export function parseAutoRun(raw: unknown): AutoRun {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(ACTION_KINDS.map((k) => [k, ACTIONS[k].risk === "safe" && src[k] === true])) as AutoRun;
}

export class AutoRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoRunInputError";
  }
}

// Pure: input from a request (possibly crafted) → the changes it asks for. Only known kinds, only booleans; a risky kind
// is accepted but forced to false. Throws AutoRunInputError otherwise.
export function validateAutoRun(input: unknown): Partial<AutoRun> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AutoRunInputError("Send the switches as an object.");
  const out: Partial<AutoRun> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.hasOwn(ACTIONS, k)) throw new AutoRunInputError("Unknown action kind.");
    if (typeof v !== "boolean") throw new AutoRunInputError("Each switch must be on or off.");
    out[k as ProposalAction] = ACTIONS[k as ProposalAction].risk === "safe" ? v : false;
  }
  return out;
}

// Pure: "Check again now off → on, …" or null when nothing changed.
export function autoRunChanges(before: AutoRun, after: AutoRun): string | null {
  const list = ACTION_KINDS.filter((k) => before[k] !== after[k]).map((k) => `${ACTIONS[k].label} ${before[k] ? "on" : "off"} → ${after[k] ? "on" : "off"}`);
  return list.length ? list.join(", ") : null;
}

export type AutoRunDeps = {
  read: () => Promise<unknown>;
  write: (value: AutoRun | AutoRollback | StoredAutoSecurity) => Promise<void>;
  audit: (e: { message: string; detail: string; actorUserId: string }) => Promise<void>;
};

const DEPS: AutoRunDeps = {
  read: async () => {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, AUTO_RUN_SETTING)).limit(1);
    return row?.value ?? null;
  },
  write: async (value) => {
    await db().insert(settings).values({ key: AUTO_RUN_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  },
  audit: (e) => recordAction({ kind: "ok", message: e.message, detail: e.detail.slice(0, 500), resourceId: null, actorUserId: e.actorUserId }),
};

export async function readAutoRun(deps: Partial<AutoRunDeps> = {}): Promise<AutoRun> {
  return parseAutoRun(await { ...DEPS, ...deps }.read());
}

// Merges the asked-for changes into the saved setting and saves it; audits what changed (nothing changed → no write, no
// audit). Throws AutoRunInputError on invalid input. A failed audit write is logged and doesn't undo the change.
export async function writeAutoRun(next: Partial<AutoRun>, actor: { userId: string }, deps: Partial<AutoRunDeps> = {}): Promise<AutoRun> {
  const d = { ...DEPS, ...deps };
  const changes = validateAutoRun(next);
  const before = parseAutoRun(await d.read());
  const after = parseAutoRun({ ...before, ...changes });
  const diff = autoRunChanges(before, after);
  if (!diff) return after;
  await d.write(after);
  await d.audit({ message: ACTIONS_COPY.settingsAudit.autoRun, detail: diff, actorUserId: actor.userId })
    .catch(() => console.warn("settings audit failed"));
  return after;
}

// Auto-rollback after a bad production deploy (owner 16 Oct): ops.settings "office.autoRollback" { enabled, windowMin }.
// Off by default. When on, a vercel_rollback proposal from a down monitor or an error spike, made within windowMin minutes
// of a new production deploy, runs without asking (proposals-db.ts checks the guards). Separate from the per-kind
// auto-run switches above, which never cover a risky kind.
export const AUTO_ROLLBACK_SETTING = "office.autoRollback";
export const ROLLBACK_WINDOW_DEFAULT = 30;
export const ROLLBACK_WINDOW_MIN = 10;
export const ROLLBACK_WINDOW_MAX = 120;
export type AutoRollback = { enabled: boolean; windowMin: number };
export const AUTO_ROLLBACK_OFF: AutoRollback = { enabled: false, windowMin: ROLLBACK_WINDOW_DEFAULT };

const windowOk = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= ROLLBACK_WINDOW_MIN && v <= ROLLBACK_WINDOW_MAX;

// Pure: whatever is stored → a full AutoRollback. enabled only when exactly true; a window outside 10–120 (or not a whole
// number) → the default.
export function parseAutoRollback(raw: unknown): AutoRollback {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { enabled: src.enabled === true, windowMin: windowOk(src.windowMin) ? src.windowMin : ROLLBACK_WINDOW_DEFAULT };
}

// Pure: request input → the changes it asks for ({ enabled?: boolean, windowMin?: 10–120 whole minutes }). Throws
// AutoRunInputError otherwise.
export function validateAutoRollback(input: unknown): Partial<AutoRollback> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AutoRunInputError("Send the setting as an object.");
  const out: Partial<AutoRollback> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new AutoRunInputError("The switch must be on or off.");
      out.enabled = v;
    } else if (k === "windowMin") {
      if (!windowOk(v)) throw new AutoRunInputError(`The window must be ${ROLLBACK_WINDOW_MIN}–${ROLLBACK_WINDOW_MAX} minutes.`);
      out.windowMin = v;
    } else throw new AutoRunInputError("Unknown setting.");
  }
  return out;
}

// Pure: "Auto-rollback off → on, window 30 → 45 min" or null when nothing changed.
export function autoRollbackChanges(before: AutoRollback, after: AutoRollback): string | null {
  const list = [
    before.enabled !== after.enabled ? `Auto-rollback ${before.enabled ? "on" : "off"} → ${after.enabled ? "on" : "off"}` : null,
    before.windowMin !== after.windowMin ? `window ${before.windowMin} → ${after.windowMin} min` : null,
  ].filter(Boolean);
  return list.length ? list.join(", ") : null;
}

const ROLLBACK_DEPS: AutoRunDeps = {
  ...DEPS,
  read: async () => {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, AUTO_ROLLBACK_SETTING)).limit(1);
    return row?.value ?? null;
  },
  write: async (value) => {
    await db().insert(settings).values({ key: AUTO_ROLLBACK_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  },
};

export async function readAutoRollback(deps: Partial<AutoRunDeps> = {}): Promise<AutoRollback> {
  return parseAutoRollback(await { ...ROLLBACK_DEPS, ...deps }.read());
}

// Like writeAutoRun: merge, save, audit what changed (nothing changed → no write, no audit).
export async function writeAutoRollback(next: Partial<AutoRollback>, actor: { userId: string }, deps: Partial<AutoRunDeps> = {}): Promise<AutoRollback> {
  const d = { ...ROLLBACK_DEPS, ...deps };
  const changes = validateAutoRollback(next);
  const before = parseAutoRollback(await d.read());
  const after = parseAutoRollback({ ...before, ...changes });
  const diff = autoRollbackChanges(before, after);
  if (!diff) return after;
  await d.write(after);
  await d.audit({ message: ACTIONS_COPY.settingsAudit.autoRollback, detail: diff, actorUserId: actor.userId })
    .catch(() => console.warn("settings audit failed"));
  return after;
}

// Automatic security fixes (owner 16 Oct: "Auto aja, soalnya tentang keamanan dependencies"): ops.settings
// "office.autoSecurity" { enabled, severities, sameMajorOnly, moderate }. ON by default for critical, high and moderate. When on, an
// update-PR proposal (github_bump_pr) runs without asking if its packages are direct, stay in their major and are at a
// chosen severity, and the merge watcher merges Watchbell's PRs once CI, the Vercel preview and its smoke test pass, but
// only while auto-rollback is on. sameMajorOnly is always true (a major jump always waits for the owner). Low and
// unknown advisories are shown, never fixed automatically.
// Watchbell 1.2.1 (owner 1a: "Moderate is treated like High"): a row saved before 1.2.1 has no `moderate` key, and reads
// with Moderate as its High switch (on for the default critical+high); a new install has it on. Every save writes the
// key, so the owner's later choice for Moderate sticks.
export const AUTO_SECURITY_SETTING = "office.autoSecurity";
export const SECURITY_LEVELS = ["critical", "high", "moderate"] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];
export type AutoSecurity = { enabled: boolean; severities: SecurityLevel[]; sameMajorOnly: true };
export const AUTO_SECURITY_DEFAULT: AutoSecurity = { enabled: true, severities: ["critical", "high", "moderate"], sameMajorOnly: true };
// What is stored: the setting plus the explicit Moderate choice.
export type StoredAutoSecurity = AutoSecurity & { moderate: boolean };
export const storedAutoSecurity = (s: AutoSecurity): StoredAutoSecurity => ({ ...s, moderate: s.severities.includes("moderate") });

const levelsOf = (v: unknown): SecurityLevel[] | null =>
  Array.isArray(v) && v.every((x) => (SECURITY_LEVELS as readonly unknown[]).includes(x)) ? SECURITY_LEVELS.filter((l) => v.includes(l)) : null;

// Pure: whatever is stored → a full AutoSecurity. Nothing stored → the default (on); a stored row decides enabled
// (only exactly true is on) and its severities when they are a valid list (else critical and high); Moderate follows
// the row's `moderate` key; without it (a row saved before 1.2.1) it follows High, since Moderate is treated like High.
export function parseAutoSecurity(raw: unknown): AutoSecurity {
  if (raw === null || raw === undefined) return { ...AUTO_SECURITY_DEFAULT, severities: [...AUTO_SECURITY_DEFAULT.severities] };
  const src = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const listed = levelsOf(src.severities) ?? ["critical", "high"];
  const moderate = typeof src.moderate === "boolean" ? src.moderate : listed.includes("high");
  return { enabled: src.enabled === true, severities: SECURITY_LEVELS.filter((l) => (l === "moderate" ? moderate : listed.includes(l))), sameMajorOnly: true };
}

export function validateAutoSecurity(input: unknown): Partial<AutoSecurity> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AutoRunInputError("Send the setting as an object.");
  const out: Partial<AutoSecurity> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new AutoRunInputError("The switch must be on or off.");
      out.enabled = v;
    } else if (k === "severities") {
      const l = levelsOf(v);
      if (!l) throw new AutoRunInputError("Severities are critical, high and/or moderate.");
      out.severities = l;
    } else if (k === "sameMajorOnly") {
      if (v !== true) throw new AutoRunInputError("Major updates always wait for you.");
    } else throw new AutoRunInputError("Unknown setting.");
  }
  return out;
}

export function autoSecurityChanges(before: AutoSecurity, after: AutoSecurity): string | null {
  const list = [
    before.enabled !== after.enabled ? `Automatic security fixes ${before.enabled ? "on" : "off"} → ${after.enabled ? "on" : "off"}` : null,
    before.severities.join(",") !== after.severities.join(",") ? `severities ${before.severities.join("+") || "none"} → ${after.severities.join("+") || "none"}` : null,
  ].filter(Boolean);
  return list.length ? list.join(", ") : null;
}

const SECURITY_DEPS: AutoRunDeps = {
  ...DEPS,
  read: async () => {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, AUTO_SECURITY_SETTING)).limit(1);
    return row?.value ?? null;
  },
  write: async (value) => {
    await db().insert(settings).values({ key: AUTO_SECURITY_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  },
};

export async function readAutoSecurity(deps: Partial<AutoRunDeps> = {}): Promise<AutoSecurity> {
  return parseAutoSecurity(await { ...SECURITY_DEPS, ...deps }.read());
}

export async function writeAutoSecurity(next: Partial<AutoSecurity>, actor: { userId: string }, deps: Partial<AutoRunDeps> = {}): Promise<AutoSecurity> {
  const d = { ...SECURITY_DEPS, ...deps };
  const changes = validateAutoSecurity(next);
  const before = parseAutoSecurity(await d.read());
  // The merged list decides Moderate too (storedAutoSecurity sets the key from it).
  const after = parseAutoSecurity(storedAutoSecurity({ ...before, ...changes }));
  const diff = autoSecurityChanges(before, after);
  if (!diff) return after;
  await d.write(storedAutoSecurity(after));
  await d.audit({ message: ACTIONS_COPY.settingsAudit.autoSecurity, detail: diff, actorUserId: actor.userId })
    .catch(() => console.warn("settings audit failed"));
  return after;
}
