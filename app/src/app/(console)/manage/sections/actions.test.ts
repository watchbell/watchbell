import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), revalidatePath: vi.fn(), recordAction: vi.fn(), readSectionsOff: vi.fn(), saveSectionsOff: vi.fn(), releaseHeldNotices: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/settings-db", () => ({ readSectionsOff: h.readSectionsOff, saveSectionsOff: h.saveSectionsOff }));
vi.mock("@/lib/data/sections-db", () => ({ releaseHeldNotices: h.releaseHeldNotices }));

import { setSectionOn } from "./actions";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.requireActionMember.mockResolvedValue(owner);
  h.recordAction.mockResolvedValue(undefined);
  h.readSectionsOff.mockResolvedValue([]);
  h.saveSectionsOff.mockResolvedValue(undefined);
  h.releaseHeldNotices.mockResolvedValue(undefined);
});

describe("setSectionOn (Manage › Sections)", () => {
  it("is Owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await setSectionOn("hosting", false)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.saveSectionsOff).not.toHaveBeenCalled();
  });

  it("turns a section off, audits it and refreshes the menu", async () => {
    h.readSectionsOff.mockResolvedValue(["devops"]);
    expect(await setSectionOn("hosting", false)).toEqual({ ok: true, message: "Hosting is off. Its data is kept." });
    expect(h.saveSectionsOff).toHaveBeenCalledWith(["devops", "hosting"]);
    expect(h.releaseHeldNotices).not.toHaveBeenCalled();
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", message: "Sections: Hosting turned off", resourceId: null, actorUserId: "user-1" }));
    expect(h.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("turns it on again", async () => {
    h.readSectionsOff.mockResolvedValue(["hosting", "devops"]);
    expect(await setSectionOn("hosting", true)).toEqual({ ok: true, message: "Hosting is on." });
    expect(h.saveSectionsOff).toHaveBeenCalledWith(["devops"]);
    expect(h.releaseHeldNotices).toHaveBeenCalledWith("hosting", expect.any(Date)); // its held notices go out next run
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Sections: Hosting turned on" }));
  });

  it("refuses to turn Home or Manage off, and an unknown section", async () => {
    expect(await setSectionOn("home", false)).toEqual({ ok: false, error: "Home is always on." });
    expect(await setSectionOn("manage", false)).toEqual({ ok: false, error: "Manage is always on." });
    expect(await setSectionOn("cloud", false)).toEqual({ ok: false, error: "Unknown section." });
    expect(h.saveSectionsOff).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("writes nothing when nothing changes", async () => {
    h.readSectionsOff.mockResolvedValue(["database"]);
    expect(await setSectionOn("database", false)).toEqual({ ok: true, message: "Nothing changed." });
    expect(await setSectionOn("hosting", true)).toEqual({ ok: true, message: "Nothing changed." });
    expect(h.saveSectionsOff).not.toHaveBeenCalled();
  });
});
