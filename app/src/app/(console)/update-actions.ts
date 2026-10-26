"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { markVersionSeen } from "@/lib/collector/self-update";

// 1.2.3: "Got it" on the What's new banner (self-hosted, owner only).
const deps = { requireActionMember };

export async function dismissWhatsNew(): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    await markVersionSeen();
    refresh();
    return { ok: true, message: "Got it." };
  }, deps);
}
