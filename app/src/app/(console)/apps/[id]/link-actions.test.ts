import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const DB = "223e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), updateTag: vi.fn(), saveLink: vi.fn(), readAliasBook: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh, updateTag: h.updateTag }));
vi.mock("@/lib/data/databases-db", () => ({ saveLink: h.saveLink }));
vi.mock("@/lib/data/aliases-db", () => ({ readAliasBook: h.readAliasBook }));

import { saveDatabaseLink } from "./link-actions";

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.saveLink.mockResolvedValue({ ok: true, message: "web-Quillpad now uses quillpad (Supabase)." });
  h.readAliasBook.mockResolvedValue({ db: [{ id: DB, name: "quillpad", alias: "db-b" }], app: [{ id: APP, name: "web-Quillpad", alias: "app-a" }] });
});

describe("saveDatabaseLink", () => {
  it("needs an Operator or Owner; a Viewer is refused", async () => {
    await saveDatabaseLink(APP, DB);
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveDatabaseLink(APP, DB)).toEqual({ ok: false, error: "You don't have permission to do that." });
  });
  it("rejects ids that aren't UUIDs before anything else", async () => {
    expect(await saveDatabaseLink("nope", DB)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await saveDatabaseLink(APP, "x")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.saveLink).not.toHaveBeenCalled();
  });
  it("saves the link (or none) with the acting user and refreshes the page", async () => {
    // Privacy: the toast names the database by its alias.
    expect(await saveDatabaseLink(APP, DB)).toEqual({ ok: true, message: "web-Quillpad now uses db-b (Supabase)." });
    expect(h.saveLink).toHaveBeenCalledWith(APP, DB, "user-1");
    await saveDatabaseLink(APP, null);
    expect(h.saveLink).toHaveBeenLastCalledWith(APP, null, "user-1");
    expect(h.refresh).toHaveBeenCalled();
  });
  it("is rate limited like other console writes", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await saveDatabaseLink(APP, DB)).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
  });
  it("expires the cached database lists of every provider, since Used by changed (perf P3)", async () => {
    await saveDatabaseLink(APP, DB);
    expect(h.updateTag.mock.calls).toEqual([["db:supabase"], ["db:neon"], ["db:firebase"]]);
    expect(h.refresh.mock.invocationCallOrder[0]).toBeLessThan(h.updateTag.mock.invocationCallOrder[0]); // review m2
  });
  it("expires nothing when the link wasn't saved", async () => {
    h.saveLink.mockResolvedValue({ ok: false, error: "That app is no longer in the console." });
    await saveDatabaseLink(APP, DB);
    expect(h.updateTag).not.toHaveBeenCalled();
  });
});

describe("saveDatabaseLink toast (privacy)", () => {
  it("never shows the name when the letters can't be read; the link is saved anyway", async () => {
    h.readAliasBook.mockRejectedValue(new Error("db down"));
    expect(await saveDatabaseLink(APP, DB)).toEqual({ ok: true, message: "The database link is saved." });
  });
});
