import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/lib/data/fake-db";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown }, requireActionMember: vi.fn(), revalidatePath: vi.fn(), updateTag: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath, updateTag: h.updateTag }));

import { removeAccount } from "./actions";

beforeEach(() => {
  h.requireActionMember.mockReset().mockResolvedValue(member);
  h.revalidatePath.mockReset();
  h.updateTag.mockReset();
});

describe("Remove account (perf P3)", () => {
  it("its resources go with it, so every cached list is expired", async () => {
    h.current = fakeDb([], [[{ provider: "neon", label: "utama" }]]);
    expect(await removeAccount("123e4567-e89b-42d3-a456-426614174000")).toEqual({ ok: true, message: "Neon · utama removed. Its credential is deleted." });
    expect(h.updateTag.mock.calls).toEqual([["db:supabase"], ["db:neon"], ["db:firebase"], ["db:extra"], ["net:zones"], ["net:domains"], ["status"]]);
  });
  it("nothing to expire when the account was already gone", async () => {
    h.current = fakeDb([], [[]]);
    expect(await removeAccount("123e4567-e89b-42d3-a456-426614174000")).toEqual({ ok: false, error: "That account no longer exists." });
    expect(h.updateTag).not.toHaveBeenCalled();
  });
});
