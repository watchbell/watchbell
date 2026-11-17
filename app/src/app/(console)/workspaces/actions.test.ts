import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const P = "00000000-0000-4000-8000-00000000f001";
const K = "00000000-0000-4000-8000-0000000000b1";
const owner = { id: "mem-1", userId: "user-1", email: "owner@studio.example", role: "owner" as const };
const viewer = { ...owner, id: "mem-3", userId: "user-3", role: "viewer" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), refresh: vi.fn(), revalidatePath: vi.fn(), recordAction: vi.fn(), set: vi.fn(),
  moveResources: vi.fn(), moveRepos: vi.fn(),
  listWorkspaces: vi.fn(), createWorkspace: vi.fn(), renameWorkspace: vi.fn(), reorderWorkspaces: vi.fn(), deleteWorkspace: vi.fn(), setDefaultWorkspace: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ refresh: h.refresh, revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: h.set, get: () => undefined }) }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
const cacheTags = vi.hoisted(() => ({ updateTags: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({ updateTags: cacheTags.updateTags }));
vi.mock("@/lib/data/workspace-db", () => ({
  listWorkspaces: h.listWorkspaces, createWorkspace: h.createWorkspace, renameWorkspace: h.renameWorkspace, reorderWorkspaces: h.reorderWorkspaces,
  deleteWorkspace: h.deleteWorkspace, setDefaultWorkspace: h.setDefaultWorkspace, dismissUnsorted: vi.fn(), moveResources: h.moveResources, moveRepos: h.moveRepos,
}));

import { createWorkspaceAction, deleteWorkspaceAction, moveToWorkspace, renameWorkspaceAction, setDefaultWorkspaceAction, switchWorkspace } from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.listWorkspaces.mockResolvedValue([{ id: P, name: "Personal", position: 0 }, { id: K, name: "Kopi Senja", position: 1 }]);
});

// Watchbell 1.8 (spec §5).
describe("switchWorkspace", () => {
  it("writes only the cookie, for any member, and refuses an unknown workspace", async () => {
    h.requireActionMember.mockResolvedValue(viewer);
    expect(await switchWorkspace(K)).toMatchObject({ ok: true });
    expect(h.set).toHaveBeenCalledWith("wb_ws", K, expect.objectContaining({ path: "/", sameSite: "lax", httpOnly: true }));
    expect(await switchWorkspace("all")).toMatchObject({ ok: true });
    expect(await switchWorkspace("00000000-0000-4000-8000-0000000000ff")).toMatchObject({ ok: false });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});

describe("managing workspaces", () => {
  it("is the owner's: a viewer changes nothing", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await createWorkspaceAction("Northwind")).ok).toBe(false);
    expect((await deleteWorkspaceAction(K)).ok).toBe(false);
    expect(h.createWorkspace).not.toHaveBeenCalled();
    expect(h.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("creates one, opens it, and names it in the audit line", async () => {
    h.createWorkspace.mockResolvedValue({ id: K });
    expect(await createWorkspaceAction("Kopi Senja")).toMatchObject({ ok: true });
    expect(h.set).toHaveBeenCalledWith("wb_ws", K, expect.anything());
    expect(h.recordAction.mock.calls[0][0].message).toBe("Workspace created: Kopi Senja");
    h.createWorkspace.mockResolvedValue({ error: "taken" });
    expect(await createWorkspaceAction("Personal")).toEqual({ ok: false, error: "A workspace with that name already exists.", fieldErrors: { name: "A workspace with that name already exists." } });
  });

  it("renames, sets the default and deletes with plain reasons", async () => {
    h.renameWorkspace.mockResolvedValue("ok");
    expect(await renameWorkspaceAction(K, "Kopi Senja Coffee")).toMatchObject({ ok: true });
    expect(h.recordAction.mock.calls.at(-1)?.[0].message).toBe("Workspace renamed: Kopi Senja → Kopi Senja Coffee");
    h.setDefaultWorkspace.mockResolvedValue(true);
    expect(await setDefaultWorkspaceAction(K)).toMatchObject({ ok: true });
    h.deleteWorkspace.mockResolvedValue({ error: "default" });
    expect(await deleteWorkspaceAction(P)).toEqual({ ok: false, error: "This is the default workspace. Choose another default first." });
    h.deleteWorkspace.mockResolvedValue({ moved: 4, statusPageRemoved: true });
    expect(await deleteWorkspaceAction(K)).toEqual({ ok: true, message: "Kopi Senja deleted. 4 things moved to the default workspace; its status page was removed." });
  });
});

// Spec §5 Moving: operators and owners; recorded in Events without addresses.
describe("moveToWorkspace", () => {
  it("moves things and repositories, and records it", async () => {
    h.moveResources.mockResolvedValue({ moved: 2, children: 3, repos: 1 });
    expect(await moveToWorkspace("resource", ["r1", "r2"], K)).toEqual({ ok: true, message: "Moved 2 to Kopi Senja (with 3 domains and 1 repository)." });
    expect(h.moveResources).toHaveBeenCalledWith(["r1", "r2"], K);
    expect(h.recordAction.mock.calls.at(-1)?.[0].message).toBe("Moved 2 to Kopi Senja");
    h.moveRepos.mockResolvedValue(1);
    expect(await moveToWorkspace("repo", ["g1"], K)).toEqual({ ok: true, message: "Moved 1 to Kopi Senja." });
  });

  it("refuses a viewer, an unknown workspace and nothing chosen", async () => {
    expect(await moveToWorkspace("resource", [], K)).toEqual({ ok: false, error: "Choose what to move." });
    expect(await moveToWorkspace("resource", ["r1"], "00000000-0000-4000-8000-0000000000ff")).toEqual({ ok: false, error: "That workspace no longer exists." });
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await moveToWorkspace("resource", ["r1"], K)).ok).toBe(false);
    expect(h.moveResources).not.toHaveBeenCalledWith(["r1"], expect.anything());
  });
});

// Final review (1.8, I3): a move or a delete changes which workspace's cached lists a row is in, so the cached reads
// (databases, domains, zones) are expired at once, not after 5 minutes.
describe("moving and deleting expire the cached lists", () => {
  it("expires every database, domain and zone tag", async () => {
    h.moveResources.mockResolvedValue({ moved: 1, children: 0, repos: 0 });
    await moveToWorkspace("resource", ["r1"], K);
    expect(cacheTags.updateTags).toHaveBeenCalledWith(expect.arrayContaining(["db:supabase", "db:neon", "db:firebase", "db:extra", "net:domains", "net:zones"]));
    cacheTags.updateTags.mockClear();
    h.deleteWorkspace.mockResolvedValue({ moved: 2, statusPageRemoved: false });
    await deleteWorkspaceAction(K);
    expect(cacheTags.updateTags).toHaveBeenCalledWith(expect.arrayContaining(["db:supabase", "net:zones"]));
  });
});

// 1.8.3 (1.8.1 deferred minor): a workspace deleted in Settings stayed in the Move to… lists of pages the browser
// already held. Creating, renaming and deleting expire every page's cached render, so each list is read again.
describe("changing the workspace list refreshes every page (1.8.3)", () => {
  it("create, rename and delete revalidate the whole layout", async () => {
    h.createWorkspace.mockResolvedValue({ id: K });
    await createWorkspaceAction("Northwind");
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/", "layout");
    h.revalidatePath.mockClear();
    h.renameWorkspace.mockResolvedValue("ok");
    await renameWorkspaceAction(K, "Kopi Senja Coffee");
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/", "layout");
    h.revalidatePath.mockClear();
    h.deleteWorkspace.mockResolvedValue({ moved: 0, statusPageRemoved: false });
    await deleteWorkspaceAction(K);
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/", "layout");
  });
  it("a refused change revalidates nothing", async () => {
    h.deleteWorkspace.mockResolvedValue({ error: "default" });
    await deleteWorkspaceAction(K);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
