"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { logoProblem, parseBrandForm } from "@/lib/branding";
import { recordAction } from "@/lib/data/audit-db";
import { saveBrand, saveBrandLogo } from "@/lib/data/branding-db";

// Watchbell 1.7 (spec §2.5): Branding is the owner's alone, like the rest of Settings. In the demo it only touches the
// visitor's own demo database.
const deps = { requireActionMember };

async function audit(message: string, userId: string) {
  try {
    await recordAction({ kind: "ok", message, resourceId: null, actorUserId: userId });
  } catch {
    console.warn("audit event failed");
  }
}

export async function saveBranding(form: FormData): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
    const parsed = parseBrandForm(fields);
    const file = form.get("logo");
    let logo: Uint8Array | null = null;
    if (file && typeof file === "object" && "arrayBuffer" in file && (file as Blob).size > 0) {
      logo = new Uint8Array(await (file as Blob).arrayBuffer());
      const problem = logoProblem(logo);
      if (problem) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { ...(parsed.ok ? {} : parsed.fieldErrors), logo: problem } };
    }
    if (!parsed.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };
    await saveBrand(parsed.value);
    if (logo) await saveBrandLogo(logo);
    await audit("Branding saved", member.userId);
    refresh();
    return { ok: true, message: "Branding saved." };
  }, deps, "local");
}

export async function removeBrandLogo(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    await saveBrandLogo(null);
    await audit("Branding logo removed", member.userId);
    refresh();
    return { ok: true, message: "Logo removed." };
  }, deps, "local");
}
