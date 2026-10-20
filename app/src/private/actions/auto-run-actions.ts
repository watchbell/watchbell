"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { requireActionMember } from "@/lib/auth";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { type AutoRollback, AutoRunInputError, type AutoSecurity, writeAutoRollback, writeAutoRun, writeAutoSecurity } from "./proposals-settings";
import { ACTIONS, type AutoRun, type ProposalAction } from "./proposals-types";

// Read at call time (not at import): the registry imports this module, and some tests mock @/lib/auth partially.
const deps = { requireActionMember: (min: Parameters<typeof requireActionMember>[0]) => requireActionMember(min) };

// Settings › Office auto-run (Stage 9 slice 1): Owner only, rate limited like the other switches, audited by writeAutoRun.
// The input is whatever the browser sent: writeAutoRun refuses unknown kinds and non-booleans and keeps risky kinds off.
export async function saveOfficeAutoRun(input: Partial<AutoRun>): Promise<ActionResult<AutoRun>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AutoRun>> => {
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    try {
      const saved = await writeAutoRun(input, member);
      revalidatePath("/settings");
      const keys = Object.keys(input ?? {}) as ProposalAction[];
      const one = keys.length === 1 && ACTIONS[keys[0]]?.risk === "safe" ? `${ACTIONS[keys[0]].label}: auto-run ${saved[keys[0]] ? "on" : "off"}.` : ACTIONS_COPY.autoRunSaved;
      return { ok: true, message: one, data: saved };
    } catch (e) {
      if (e instanceof AutoRunInputError) return { ok: false, error: "Something in that request wasn't valid." };
      throw e;
    }
  }, deps, "local");
}

// Settings › Office auto-run › Auto-rollback (owner 16 Oct): Owner only, rate limited and audited like the switches above.
export async function saveOfficeAutoRollback(input: Partial<AutoRollback>): Promise<ActionResult<AutoRollback>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AutoRollback>> => {
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    try {
      const saved = await writeAutoRollback(input, member);
      revalidatePath("/settings");
      return { ok: true, message: `Auto-rollback ${saved.enabled ? "on" : "off"} · first ${saved.windowMin} minutes.`, data: saved };
    } catch (e) {
      if (e instanceof AutoRunInputError) return { ok: false, error: "Something in that request wasn't valid." };
      throw e;
    }
  }, deps, "local");
}

// Settings › Office auto-run › Automatic security fixes (owner 16 Oct): Owner only, rate limited, audited.
export async function saveOfficeAutoSecurity(input: Partial<AutoSecurity>): Promise<ActionResult<AutoSecurity>> {
  return runGuarded("owner", async (member): Promise<ActionResult<AutoSecurity>> => {
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    try {
      const saved = await writeAutoSecurity(input, member);
      revalidatePath("/settings");
      return { ok: true, message: `Automatic security fixes ${saved.enabled ? "on" : "off"}.`, data: saved };
    } catch (e) {
      if (e instanceof AutoRunInputError) return { ok: false, error: "Something in that request wasn't valid." };
      throw e;
    }
  }, deps, "local");
}
