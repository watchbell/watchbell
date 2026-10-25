import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { slotStart } from "@/lib/collector/schedule";
import { DEPS_STEP_MS, type DepsSecurityRun, depsSecurityStep, MIN_REPO_MS } from "@/lib/data/deps-db";
import { runSecurityChecks, type SecurityPick, type SecurityRun } from "@/lib/data/security-db";
import type { SectionId } from "@/lib/sections";
import {
  AFTER_DEPLOY_SETTING, type AfterDeploy, type DeployMark, expireMarks, hasPending, markDeploys, marksNeeding, parseAfterDeploy, recordRun, type RunOutcome,
} from "@/lib/security/after-deploy";
import { DAILY_STEP_MS } from "@/lib/security/check";
import { addIds, CUT_TRIES, parseSlot, SLOT_SETTING, slotComplete, type SlotProgress } from "@/lib/security/slot";

// Watchbell 1.2.1 (owner 23 Oct): the collector's `security` task (lib/collector/schedule.ts), every 6 hours and early
// after a new production deployment. Two parts, each paused with its section (Manage › Sections): the Next.js check of
// the watched apps (Hosting: one page read and one OSV.dev query per app) and the dependency scan of their linked
// repositories (DevOps: GitHub; an unchanged lockfile is not downloaded or queried again). The daily job's steps stay.
//
// The 6-hourly slot (fix round 1, review important 1): one minute run can't check every app and scan every repository,
// so the slot continues in the next minute runs (oldest first, ops.settings "security.slot" remembers what this slot
// tried) and is complete only when both parts went through their lists; runCollector saves the slot as done only then.
// A slot run does the dependency part first, then the Next.js checks with the rest of the window; a check cut by the
// time limit is tried again in a later run of the slot, CUT_TRIES times at most (fix round 2).
//
// After a deploy: the apps marked by the Vercel task (ops.settings "security.afterDeploy") go first; an early run checks
// only them. Each part of a mark is done once (review important 2): a finished part isn't repeated, a check that ran
// out of time is an attempt, and after MAX_ATTEMPTS the mark is settled. The marks are saved even when a part throws
// (the TTL too: review minor 4).

export type SecurityTaskDeps = {
  read: () => Promise<unknown>;
  write: (value: AfterDeploy) => Promise<void>;
  readSlot: () => Promise<unknown>;
  writeSlot: (value: SlotProgress) => Promise<void>;
  nextCheck: (deadline: number, pick: SecurityPick) => Promise<SecurityRun>;
  depsStep: (deadline: number, pick: { marked: readonly string[]; onlyMarked: boolean; skip?: readonly string[] }) => Promise<DepsSecurityRun>;
};

const readKey = (key: string) => async (): Promise<unknown> => {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
};
const writeKey = (key: string) => async (value: unknown): Promise<void> => {
  await db().insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
};

const DEPS: SecurityTaskDeps = {
  read: readKey(AFTER_DEPLOY_SETTING), write: writeKey(AFTER_DEPLOY_SETTING), readSlot: readKey(SLOT_SETTING), writeSlot: writeKey(SLOT_SETTING),
  nextCheck: runSecurityChecks, depsStep: (deadline, pick) => depsSecurityStep(deadline, pick),
};

export type SecurityTaskCtx = { now: Date; deadline: number; errors: string[]; paused: ReadonlySet<SectionId>; early: boolean };

// complete: the 6-hourly slot is done (always true for an early run, which leaves the slot alone).
export async function taskSecurity(ctx: SecurityTaskCtx, deps: SecurityTaskDeps = DEPS): Promise<{ complete: boolean }> {
  const before = parseAfterDeploy(await deps.read());
  const marks = expireMarks(before, ctx.now);
  const hosting = !ctx.paused.has("hosting");
  const devops = !ctx.paused.has("devops");
  const needNext = hosting ? marksNeeding(marks, "next") : [];
  const needDeps = devops ? marksNeeding(marks, "deps") : [];
  const slot = ctx.early ? null : parseSlot(await deps.readSlot(), new Date(slotStart("security", ctx.now)).toISOString());
  // What the slot still has to go through (a marked app's part always runs).
  const slotNext = !!slot && hosting && !slot.nextDone;
  const slotDeps = !!slot && devops && !slot.depsDone;
  const doNext = hosting && (needNext.length > 0 || slotNext);
  const doDeps = devops && (needDeps.length > 0 || slotDeps);
  const outcome: { hosting: boolean; devops: boolean; nextDone: Set<string>; nextStarted: Set<string>; depsDone: Set<string> } = {
    hosting, devops, nextDone: new Set(), nextStarted: new Set(), depsDone: new Set(),
  };
  const nextPart = async () => {
    // A slot run gives the Next.js checks the rest of the window (the dependency part ran first); an early run that has
    // both parts to do leaves the dependency part two repositories' worth of time.
    const until = Math.min(Date.now() + DAILY_STEP_MS, !slot && doDeps ? ctx.deadline - 2 * MIN_REPO_MS : ctx.deadline);
    // The slot skips the apps it finished, and those whose check was cut CUT_TRIES times; a marked app always runs.
    const tried = slotNext ? [...slot!.next, ...Object.entries(slot!.cut).filter(([, n]) => n >= CUT_TRIES).map(([a]) => a)] : [];
    const pick: SecurityPick = slotNext ? { first: needNext, skip: [...new Set(tried)].filter((a) => !needNext.includes(a)) } : { only: needNext };
    const r = await deps.nextCheck(until, pick);
    for (const f of r.failed) ctx.errors.push(`security ${f}`);
    for (const a of r.done) outcome.nextDone.add(a);
    for (const a of needNext) if (!r.listed.includes(a)) outcome.nextDone.add(a); // no longer watched: nothing to check
    for (const a of r.started) outcome.nextStarted.add(a);
    if (slotNext) {
      const done = new Set(r.done);
      slot!.next = addIds(slot!.next, r.done);
      for (const a of r.started) if (!done.has(a)) slot!.cut[a] = Math.min((slot!.cut[a] ?? 0) + 1, CUT_TRIES);
      slot!.nextDone = r.listed.every((a) => done.has(a) || (slot!.cut[a] ?? 0) >= CUT_TRIES);
    }
  };
  const depsPart = async () => {
    const r = await deps.depsStep(Math.min(Date.now() + DEPS_STEP_MS, ctx.deadline), slotDeps
      ? { marked: needDeps, onlyMarked: false, skip: slot!.repos }
      : { marked: needDeps, onlyMarked: true });
    if (r.problem) ctx.errors.push(`security deps: ${r.problem}`);
    for (const a of r.settled) outcome.depsDone.add(a);
    if (slotDeps) {
      slot!.repos = addIds(slot!.repos, r.done);
      slot!.depsDone = r.complete;
    }
  };
  try {
    if (slot) slot.runs++;
    // Fix round 2 (re-review important 1): in a slot run the dependency part goes first (each repository is bounded by
    // MIN_REPO_MS), so the Next.js checks aren't squeezed into a few seconds and cut; an early run keeps the marked
    // app's Next.js check first.
    if (slot) {
      if (doDeps) await depsPart();
      if (doNext) await nextPart();
    } else {
      if (doNext) await nextPart();
      if (doDeps) await depsPart();
    }
  } finally {
    // Fix round 2 (re-review minor 1): the slot first, each write on its own, so a failed marks write can't lose the
    // slot's progress (and its run cap); the first error is thrown after both.
    let failure: unknown = null;
    if (slot) {
      try {
        await deps.writeSlot(slot);
      } catch (e) {
        failure = e;
      }
    }
    try {
      const after = recordRun(marks, outcome satisfies RunOutcome);
      if (JSON.stringify(after) !== JSON.stringify(before)) await deps.write(after);
    } catch (e) {
      failure ??= e;
    }
    if (failure) throw failure;
  }
  return { complete: slot ? slotComplete(slot, hosting, devops) : true };
}

// The Vercel task (lib/collector/run.ts): the apps whose current production deployment just changed. One read and one
// write of the setting, only when there is something new to mark.
export async function markAfterDeploy(marks: readonly DeployMark[], now: Date, deps: Pick<SecurityTaskDeps, "read" | "write"> = DEPS): Promise<boolean> {
  if (!marks.length) return false;
  const { state, changed } = markDeploys(parseAfterDeploy(await deps.read()), marks, now);
  if (changed) await deps.write(state);
  return changed;
}

// runCollector: whether any app waits for its after-deploy check (from the setting it reads with collector.lastRun).
export const marksPending = (raw: unknown): boolean => hasPending(parseAfterDeploy(raw));
