import { beforeEach, describe, expect, it, vi } from "vitest";

const ACC = "123e4567-e89b-42d3-a456-426614174000";
const RES = "223e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), revalidatePath: vi.fn(), updateTag: vi.fn(), syncAccount: vi.fn(), saveSelection: vi.fn(), readAliasBook: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath, updateTag: h.updateTag }));
vi.mock("@/lib/sync-db", () => ({ syncAccount: h.syncAccount, saveSelection: h.saveSelection }));
vi.mock("@/lib/data/aliases-db", () => ({ readAliasBook: h.readAliasBook }));

import { saveSyncSelection, syncNow } from "./sync-actions";

const ALL = [["db:supabase"], ["db:neon"], ["db:firebase"], ["db:extra"], ["net:zones"], ["net:domains"], ["status"]];

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.syncAccount.mockResolvedValue({ ok: true, rows: [], skippedTeams: [], overLimit: null });
  h.saveSelection.mockResolvedValue({ ok: true, on: 1, total: 2, overLimit: null });
});

describe("Sync writes expire every cached list (perf P3)", () => {
  it("Sync now: resources of any kind may be renamed, added or gone", async () => {
    expect((await syncNow(ACC)).ok).toBe(true);
    expect(h.updateTag.mock.calls).toEqual(ALL);
  });
  it("Save selection: what is watched changed", async () => {
    expect((await saveSyncSelection(ACC, [RES], true)).ok).toBe(true);
    expect(h.updateTag.mock.calls).toEqual(ALL);
  });
  it("nothing is expired for a request that never reached the database", async () => {
    await syncNow("nope");
    h.saveSelection.mockResolvedValue({ ok: false, error: "That account no longer exists." });
    await saveSyncSelection(ACC, [RES], true);
    expect(h.updateTag).not.toHaveBeenCalled();
  });
});

describe("Sync dialog rows (privacy)", () => {
  const row = (id: string, badge: string, name: string) => ({ id, name, sub: "", monitored: false, fresh: true, badge });
  it("a database row carries its alias, read after Sync wrote it, so a project found just now has its letter", async () => {
    h.syncAccount.mockResolvedValue({ ok: true, rows: [row("d1", "db", "someone@gmail.com's Project"), row("d9", "fs", "x")], skippedTeams: [], overLimit: null });
    h.readAliasBook.mockResolvedValue({ db: [{ id: "d1", name: "someone@gmail.com's Project", alias: "db-c" }], app: [] });
    const r = await syncNow(ACC);
    expect(r.ok && r.data?.rows.map((x) => x.alias)).toEqual(["db-c", "db-?"]);
  });
  it("apps and zones need no letters, so no extra read", async () => {
    h.syncAccount.mockResolvedValue({ ok: true, rows: [row("a1", "app", "web")], skippedTeams: [], overLimit: null });
    const r = await syncNow(ACC);
    expect(r.ok && r.data?.rows[0].alias).toBeUndefined();
    expect(h.readAliasBook).not.toHaveBeenCalled();
  });
});
