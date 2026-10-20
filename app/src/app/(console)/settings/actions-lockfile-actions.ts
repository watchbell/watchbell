"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { saveActionsRepo } from "@/lib/data/actions-lockfile-db";
import { isActionsRepo } from "@/lib/deps/actions-lockfile";

// Lockfile through GitHub Actions (owner 16 Oct): the owner's actions repository ("owner/name"), or empty to turn it
// off. Owner only, audited. No secret here: the token lives as a GitHub Actions secret in that repository.
export async function setActionsRepoAction(raw: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const repo = typeof raw === "string" ? raw.trim() : "";
    if (repo && !isActionsRepo(repo)) return { ok: false, error: "Write it as owner/name, for example yourname/watchbell-actions." };
    await saveActionsRepo(repo || null);
    try {
      await recordAction({ kind: "ok", message: repo ? `Lockfile via GitHub Actions: ${repo}` : "Lockfile via GitHub Actions turned off", resourceId: null, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: repo ? "Saved. New update PRs send their lockfile job to this repository." : "Turned off." };
  }, { requireActionMember });
}
