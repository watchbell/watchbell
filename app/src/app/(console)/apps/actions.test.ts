import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ removeApp: vi.fn(), updateTag: vi.fn(), member: { id: "m1", userId: "u1", email: "o@x.id", role: "owner" } }));
vi.mock("next/cache", () => ({ updateTag: h.updateTag }));
vi.mock("@/lib/auth", () => ({ requireActionMember: async () => h.member }));
vi.mock("@/lib/data/apps-db", () => ({ removeApp: h.removeApp }));

import { removeAppFromConsole } from "./actions";

const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  h.removeApp.mockReset();
  h.updateTag.mockReset();
});

describe("removeAppFromConsole", () => {
  it("redirects to /apps on success, passing the acting member", async () => {
    h.removeApp.mockResolvedValue({ ok: true, message: "gone" });
    await expect(removeAppFromConsole(ID)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT;") });
    await expect(removeAppFromConsole(ID)).rejects.toMatchObject({ digest: expect.stringContaining("/apps") });
    expect(h.removeApp).toHaveBeenCalledWith(ID, "u1");
    // Its domains and its Used by entries leave the cached lists (perf P3).
    expect(h.updateTag.mock.calls.slice(0, 4)).toEqual([["db:supabase"], ["db:neon"], ["db:firebase"], ["net:domains"]]);
  });

  it("returns the error when the app is gone", async () => {
    h.removeApp.mockResolvedValue({ ok: false, error: "That app is no longer in the console." });
    expect(await removeAppFromConsole(ID)).toEqual({ ok: false, error: "That app is no longer in the console." });
    expect(h.updateTag).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID without touching the database", async () => {
    expect(await removeAppFromConsole("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.removeApp).not.toHaveBeenCalled();
  });
});
