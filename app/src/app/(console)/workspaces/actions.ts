"use server";

import { refresh, revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { createWorkspace, deleteWorkspace, dismissUnsorted, listWorkspaces, moveRepos, moveResources, renameWorkspace, reorderWorkspaces, setDefaultWorkspace } from "@/lib/data/workspace-db";
import { ALL_WORKSPACES, WS_COOKIE, wsCookieOptions } from "@/lib/workspace/choice";
import { ALL_TAGS } from "@/lib/cache/tags";
import { updateTags } from "@/lib/cache/invalidate";

// Watchbell 1.8 (spec §5): any member switches the workspace they look at (a cookie, no database write); only owners
// create, rename, reorder, delete or pick the default. Workspaces are a grouping, so the demo keeps them in the
// visitor's own database.
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";
const TAKEN = "A workspace with that name already exists.";
const NAME = "Use 1 to 60 characters.";
const GONE = "That workspace no longer exists.";

async function audit(message: string, userId: string) {
  try {
    await recordAction({ kind: "ok", message, resourceId: null, actorUserId: userId });
  } catch {
    console.warn("audit event failed");
  }
}

async function choose(value: string) {
  (await cookies()).set(WS_COOKIE, value, wsCookieOptions());
}

export async function switchWorkspace(value: string): Promise<ActionResult> {
  return runGuarded("viewer", async (): Promise<ActionResult> => {
    const list = await listWorkspaces();
    if (value !== ALL_WORKSPACES && !list.some((w) => w.id === value)) return { ok: false, error: GONE };
    await choose(value);
    refresh();
    return { ok: true };
  }, deps, "local");
}

export async function createWorkspaceAction(name: string): Promise<ActionResult<{ id: string }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ id: string }>> => {
    if (typeof name !== "string") return { ok: false, error: INVALID };
    const made = await createWorkspace(name);
    if ("error" in made) {
      const error = made.error === "taken" ? TAKEN : NAME;
      return { ok: false, error, fieldErrors: { name: error } };
    }
    await choose(made.id);
    await audit(`Workspace created: ${name.trim()}`, member.userId);
    revalidatePath("/", "layout"); // 1.8.3: every page lists the workspaces (switcher, Move to…)
    refresh();
    return { ok: true, message: `${name.trim()} created.`, data: { id: made.id } };
  }, deps, "local");
}

export async function renameWorkspaceAction(id: string, name: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (typeof id !== "string" || typeof name !== "string") return { ok: false, error: INVALID };
    const before = (await listWorkspaces()).find((w) => w.id === id)?.name;
    const r = await renameWorkspace(id, name);
    if (r === "not-found") return { ok: false, error: GONE };
    if (r !== "ok") {
      const error = r === "taken" ? TAKEN : NAME;
      return { ok: false, error, fieldErrors: { name: error } };
    }
    await audit(`Workspace renamed: ${before ?? "?"} → ${name.trim()}`, member.userId);
    revalidatePath("/", "layout");
    refresh();
    return { ok: true, message: "Renamed." };
  }, deps, "local");
}

export async function reorderWorkspacesAction(ids: string[]): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return { ok: false, error: INVALID };
    await reorderWorkspaces(ids);
    refresh();
    return { ok: true };
  }, deps, "local");
}

export async function setDefaultWorkspaceAction(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const name = (await listWorkspaces()).find((w) => w.id === id)?.name;
    if (!name || !(await setDefaultWorkspace(id))) return { ok: false, error: GONE };
    await audit(`Default workspace: ${name}`, member.userId);
    refresh();
    return { ok: true, message: `New apps, databases and domains now land in ${name}.` };
  }, deps, "local");
}

export async function deleteWorkspaceAction(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const name = (await listWorkspaces()).find((w) => w.id === id)?.name;
    if (!name) return { ok: false, error: GONE };
    const r = await deleteWorkspace(id);
    if ("error" in r) {
      if (r.error === "default") return { ok: false, error: "This is the default workspace. Choose another default first." };
      if (r.error === "last") return { ok: false, error: "The last workspace can't be deleted." };
      return { ok: false, error: GONE };
    }
    await audit(`Workspace deleted: ${name} (${r.moved} moved)`, member.userId);
    updateTags(ALL_TAGS); // final review I3: the cached lists are per workspace
    revalidatePath("/", "layout");
    refresh();
    const things = `${r.moved} thing${r.moved === 1 ? "" : "s"} moved to the default workspace`;
    return { ok: true, message: `${name} deleted. ${things}${r.statusPageRemoved ? "; its status page was removed" : ""}.` };
  }, deps, "local");
}

// Spec §5 New things: "leave them where they are" (operators and owners, like moving).
export async function dismissUnsortedAction(ids: string[]): Promise<ActionResult> {
  return runGuarded("operator", async (): Promise<ActionResult> => {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return { ok: false, error: INVALID };
    const n = await dismissUnsorted(ids);
    refresh();
    return { ok: true, message: `${n} left where ${n === 1 ? "it is" : "they are"}.` };
  }, deps, "local");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Spec §5 Moving: apps, databases, domains (a domain moves its app) or repositories to another workspace, with all
// their history. Operators and owners; the audit line names the workspace, never an address.
export async function moveToWorkspace(kind: "resource" | "repo", ids: string[], to: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if ((kind !== "resource" && kind !== "repo") || !Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return { ok: false, error: INVALID };
    if (!ids.length) return { ok: false, error: "Choose what to move." };
    const name = (await listWorkspaces()).find((w) => w.id === to)?.name;
    if (!name) return { ok: false, error: GONE };
    let moved = 0;
    const extra: string[] = [];
    if (kind === "repo") moved = await moveRepos(ids, to);
    else {
      const r = await moveResources(ids, to);
      moved = r.moved;
      if (r.children) extra.push(plural(r.children, "domain"));
      if (r.repos) extra.push(plural(r.repos, "repository", "repositories"));
    }
    await audit(`Moved ${moved} to ${name}`, member.userId);
    updateTags(ALL_TAGS); // final review I3: what moved leaves one workspace's cached lists for another's
    refresh();
    return { ok: true, message: `Moved ${moved} to ${name}${extra.length ? ` (with ${extra.join(" and ")})` : ""}.` };
  }, deps, "local");
}
