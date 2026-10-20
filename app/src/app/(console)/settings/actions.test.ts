import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import { RETENTION_DAYS } from "@/lib/collector/retention";
import { fakeDb } from "@/lib/data/fake-db";
import { BUDGET_DEFAULTS, BUDGET_FIELDS } from "@/lib/settings/budget";
import { RETENTION_KEYS } from "@/lib/settings/retention";

const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  requireActionMember: vi.fn(), revalidatePath: vi.fn(), recordAction: vi.fn(),
  readRetentionDays: vi.fn(), saveRetentionDays: vi.fn(), readBudgetLimits: vi.fn(), saveBudgetLimits: vi.fn(),
  deleteUser: vi.fn(), listUsers: vi.fn(), createUser: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/settings-db", () => ({
  readRetentionDays: h.readRetentionDays, saveRetentionDays: h.saveRetentionDays, readBudgetLimits: h.readBudgetLimits, saveBudgetLimits: h.saveBudgetLimits,
}));
vi.mock("@/lib/supabase/admin", () => ({ adminClient: () => ({ auth: { admin: { deleteUser: h.deleteUser, listUsers: h.listUsers, createUser: h.createUser } } }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://ops.example.com" }) }));

import { changeRole, inviteUser, removeMember, resetBudget, revokeInvite, saveBudget, saveRetention } from "./actions";

const retentionForm = (over: Record<string, string> = {}) => ({ ...Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(RETENTION_DAYS[k])])), ...over });
const budgetForm = (over: Record<string, string> = {}) => ({ ...Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, String(BUDGET_DEFAULTS[f.key])])), ...over });

beforeEach(() => {
  for (const f of Object.values(h)) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  h.requireActionMember.mockResolvedValue(owner);
  h.recordAction.mockResolvedValue(undefined);
  h.readRetentionDays.mockResolvedValue({ ...RETENTION_DAYS });
  h.readBudgetLimits.mockResolvedValue({ ...BUDGET_DEFAULTS });
});

describe("saveRetention (B6)", () => {
  it("is Owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveRetention(retentionForm({ checks: "14" }))).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.saveRetentionDays).not.toHaveBeenCalled();
  });
  it("saves a valid choice and audits what changed", async () => {
    const r = await saveRetention(retentionForm({ checks: "14" }));
    expect(r).toEqual({ ok: true, message: "Retention saved. The daily job uses it from its next run (03:00 WIB)." });
    expect(h.saveRetentionDays).toHaveBeenCalledWith({ ...RETENTION_DAYS, checks: 14 });
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Settings: retention changed", detail: "Raw checks 7 → 14 days", resourceId: null, actorUserId: "user-1" });
  });
  it("refuses a value outside the choices, and writes nothing when nothing changed", async () => {
    expect(await saveRetention(retentionForm({ checks: "1" }))).toMatchObject({ ok: false, fieldErrors: { checks: "Pick 3, 7, 14 days." } });
    expect(await saveRetention(retentionForm())).toEqual({ ok: true, message: "Nothing changed." });
    expect(h.saveRetentionDays).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});

describe("saveBudget / resetBudget (B6)", () => {
  it("saves corrected limits and audits them", async () => {
    expect(await saveBudget(budgetForm({ qstashPerDay: "500" }))).toEqual({ ok: true, message: "Free tier limits saved." });
    expect(h.saveBudgetLimits).toHaveBeenCalledWith({ ...BUDGET_DEFAULTS, qstashPerDay: 500 });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings: free tier limits changed", detail: "Upstash QStash messages 1,000 → 500" }));
  });
  it("refuses an alarm below the warning", async () => {
    expect(await saveBudget(budgetForm({ warnPct: "90", errPct: "50" }))).toMatchObject({ ok: false, fieldErrors: { errPct: "Alarm must be above Warn." } });
  });
  it("resets to the published defaults", async () => {
    h.readBudgetLimits.mockResolvedValue({ ...BUDGET_DEFAULTS, qstashPerDay: 500 });
    expect(await resetBudget()).toEqual({ ok: true, message: "Free tier limits reset to the published defaults." });
    expect(h.saveBudgetLimits).toHaveBeenCalledWith(BUDGET_DEFAULTS);
  });
});

describe("users, in the console only (B6, owner's rule)", () => {
  it("removing a member deletes the member row only, never the Supabase login, and audits it", async () => {
    h.current = fakeDb([[{ id: "mem-2", userId: "user-2", email: "viewer@example.com", role: "viewer" }], [{ n: 1 }]]);
    const r = await removeMember("mem-2");
    expect(r).toEqual({ ok: true, message: "viewer@example.com can't use the console anymore. Their Supabase login is left alone; delete it in Supabase → Authentication if you want." });
    expect(h.deleteUser).not.toHaveBeenCalled();
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Removed viewer@example.com from the console", resourceId: null, actorUserId: "user-1" });
  });
  it("withdrawing an invite leaves the login alone and audits it", async () => {
    h.current = fakeDb([], [[{ email: "new@example.com" }]]);
    expect(await revokeInvite("inv-1")).toEqual({ ok: true, message: "Invite for new@example.com withdrawn." });
    expect(h.listUsers).not.toHaveBeenCalled();
    expect(h.deleteUser).not.toHaveBeenCalled();
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Invite withdrawn: new@example.com" }));
  });
  it("a role change is audited with the old and new role", async () => {
    h.current = fakeDb([[{ id: "mem-2", userId: "user-2", email: "op@example.com", role: "viewer" }], [{ n: 1 }]]);
    expect(await changeRole("mem-2", "operator")).toEqual({ ok: true, message: "op@example.com is now an Operator." });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Role changed: op@example.com viewer → operator" }));
  });
});

describe("inviteUser in the cloud (unchanged by self-host members)", () => {
  it("creates the confirmed Supabase login, saves the invite and audits it", async () => {
    h.current = fakeDb([[], []]);
    h.createUser.mockResolvedValue({ error: null });
    const fd = new FormData();
    fd.set("email", " New@Example.com ");
    fd.set("role", "operator");
    expect(await inviteUser(null, fd)).toEqual({
      ok: true,
      message: "Invite saved. Ask new@example.com to sign in at https://ops.example.com/signin within 7 days. Sign-in emails reach only Supabase team members until custom SMTP is set up.",
    });
    expect(h.createUser).toHaveBeenCalledWith({ email: "new@example.com", email_confirm: true });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Invited new@example.com as operator" }));
  });
});
