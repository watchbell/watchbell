"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { releaseHeldNotices } from "@/lib/data/sections-db";
import { readSectionsOff, saveSectionsOff } from "@/lib/data/settings-db";
import { isSectionId, SECTIONS, SWITCHABLE } from "@/lib/sections";

const deps = { requireActionMember };

// Manage › Sections (Watchbell 1.2, D11): turn a section on or off. Owner only, audited like every Settings change.
// Home and Manage can't be turned off. Off hides the section and pauses its collector tasks, alert rules,
// notifications and new auto-action proposals; nothing is deleted.
export async function setSectionOn(section: string, on: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    if (!isSectionId(section)) return { ok: false, error: "Unknown section." };
    if (!SWITCHABLE.includes(section)) return { ok: false, error: `${SECTIONS[section].label} is always on.` };
    const before = await readSectionsOff();
    const isOff = before.includes(section);
    const label = SECTIONS[section].label;
    if (isOff === !on) return { ok: true, message: "Nothing changed." };
    await saveSectionsOff(on ? before.filter((s) => s !== section) : [...before, section]);
    // Back on: the notices it held restart their delivery window, so a still-firing alert goes out on the next run.
    if (on) await releaseHeldNotices(section, new Date()).catch(() => console.warn("sections: held notices not released"));
    await recordAction({
      kind: "ok", message: `Sections: ${label} turned ${on ? "on" : "off"}`, resourceId: null, actorUserId: actor.userId,
      detail: on ? "Its sync, alerts and auto-actions run again." : "Hidden from the menu; its sync, alerts and auto-actions are paused. Its data is kept.",
    }).catch(() => console.warn("sections audit failed"));
    // The menu is in the (console) layout: every page under it renders again.
    revalidatePath("/", "layout");
    return { ok: true, message: on ? `${label} is on.` : `${label} is off. Its data is kept.` };
  }, deps, "local");
}
