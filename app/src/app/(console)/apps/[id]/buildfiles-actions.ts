"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { DEMO_BUILD_FILES } from "@/lib/buildfiles/demo";
import { generateBuildFiles, type GeneratedFiles } from "@/lib/data/buildfiles-db";
import { type BuildFilesPr, openBuildFilesPr } from "@/lib/data/buildfiles-pr";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";

// Watchbell 1.5: App page → Build files → Generate. Operator+, like the Environment check; a read, so no quota and no
// audit. Demo: made-up files, no provider call.
export async function buildFilesAction(appId: string): Promise<ActionResult<GeneratedFiles>> {
  return runGuarded<GeneratedFiles>("operator", async () => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const r = await generateBuildFiles(appId);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: true, data: DEMO_BUILD_FILES }));
}

// Watchbell 1.5: Build files → Open pull request. Owner only (a write to the repository with the PR-write token); the
// finisher audits it. Demo: refused, nothing is written anywhere.
export async function buildFilesPrAction(appId: string): Promise<ActionResult<BuildFilesPr>> {
  return runGuarded<BuildFilesPr>("owner", async (member) => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    return openBuildFilesPr(member, appId);
  }, { requireActionMember }, async () => ({ ok: false, error: "Pull requests are off in the demo." }));
}
