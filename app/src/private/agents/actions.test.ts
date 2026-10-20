import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), revalidatePath: vi.fn(), renameAgent: vi.fn(), forgetAgent: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("./agents-db", () => ({ renameAgent: h.renameAgent, forgetAgent: h.forgetAgent }));

import { forgetAgentAction, renameAgentAction } from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.renameAgent.mockResolvedValue(true);
  h.forgetAgent.mockResolvedValue(true);
});

describe("agent actions", () => {
  it("are the owner's alone", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await renameAgentAction(UUID, "x")).ok).toBe(false);
    expect((await forgetAgentAction(UUID)).ok).toBe(false);
    expect(h.requireActionMember.mock.calls.every((c) => c[0] === "owner")).toBe(true);
    expect(h.renameAgent).not.toHaveBeenCalled();
    expect(h.forgetAgent).not.toHaveBeenCalled();
  });

  it("rename trims, and an empty name resets", async () => {
    expect(await renameAgentAction(UUID, "  My claw ")).toMatchObject({ ok: true, message: "Agent renamed." });
    expect(h.renameAgent).toHaveBeenCalledWith(UUID, "My claw", "mem-1");
    expect(await renameAgentAction(UUID, "")).toMatchObject({ ok: true, message: "Agent name reset." });
  });

  it("rename refuses markup and long names", async () => {
    expect((await renameAgentAction(UUID, "<b>x</b>")).ok).toBe(false);
    expect((await renameAgentAction(UUID, "x".repeat(41))).ok).toBe(false);
    expect(h.renameAgent).not.toHaveBeenCalled();
  });

  it("forget deletes by id and says so when it is already gone", async () => {
    expect(await forgetAgentAction(UUID)).toMatchObject({ ok: true });
    expect(h.forgetAgent).toHaveBeenCalledWith(UUID, "mem-1");
    h.forgetAgent.mockResolvedValue(false);
    expect((await forgetAgentAction(UUID)).ok).toBe(false);
    expect((await forgetAgentAction("nope")).ok).toBe(false);
  });
});
