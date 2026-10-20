import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";
import { openTicket } from "@/lib/backup/connect";

const key = Buffer.alloc(32, 5).toString("base64");
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), cookieSet: vi.fn(), limit: vi.fn(), runBackup: vi.fn(), recordAction: vi.fn(), removeDriveAccount: vi.fn(), revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: h.cookieSet }) }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/backup/run", () => ({ runBackup: h.runBackup }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/backup-db", () => ({ removeDriveAccount: h.removeDriveAccount }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://ops.example.com", OPS_ENCRYPTION_KEY: key }) }));

import { backUpNow, disconnectDrive, startDriveConnect } from "./actions";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  vi.stubEnv("GOOGLE_CLIENT_ID", "1234-fake.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fake-client-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("startDriveConnect", () => {
  it("is Owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await startDriveConnect()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.cookieSet).not.toHaveBeenCalled();
  });
  it("says the env is missing", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(await startDriveConnect()).toEqual({ ok: false, error: ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true) });
  });
  it("sets a sealed, httpOnly, lax, path-scoped 10-minute ticket and returns Google's URL with the same state", async () => {
    const r = await startDriveConnect();
    expect(r.ok).toBe(true);
    const url = new URL(r.data!.url);
    const [name, value, opts] = h.cookieSet.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe("wp_drive_oauth");
    expect(opts).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/auth/google", maxAge: 600 });
    const ticket = openTicket(value, key)!;
    expect(ticket.memberId).toBe("mem-1");
    expect(url.searchParams.get("state")).toBe(ticket.state);
    expect(url.searchParams.get("code_challenge")).not.toBe(ticket.verifier);
    expect(url.searchParams.get("redirect_uri")).toBe("https://ops.example.com/auth/google/callback");
    expect(value).not.toContain(ticket.verifier);
  });
});

describe("backUpNow", () => {
  it("writes the current month as partial, audits it and refreshes the page", async () => {
    h.runBackup.mockResolvedValue({ ok: true, month: "2026-10", message: "October 2026 so far saved to Google Drive.", retention: null });
    expect(await backUpNow()).toEqual({ ok: true, message: "October 2026 so far saved to Google Drive." });
    const arg = h.runBackup.mock.calls[0][0] as { month: string; partial: boolean; deadline: number };
    expect(arg.partial).toBe(true);
    expect(arg.month).toMatch(/^\d{4}-\d{2}$/);
    expect(arg.deadline).toBeLessThanOrEqual(Date.now() + 45_000);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", actorUserId: "user-1", resourceId: null }));
    expect(h.revalidatePath).toHaveBeenCalledWith("/backups");
  });
  it("is rate limited per member", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await backUpNow()).toEqual({ ok: false, error: "Too many backups. Try again in 5 minutes." });
    expect(h.runBackup).not.toHaveBeenCalled();
  });
  it("audits a failure with a short reason, but not a missing connection", async () => {
    h.runBackup.mockResolvedValue({ ok: false, month: "2026-10", kind: "failed", error: "Your Google Drive is full." });
    expect(await backUpNow()).toEqual({ ok: false, error: "Your Google Drive is full." });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", detail: "Your Google Drive is full." }));
    h.recordAction.mockReset();
    h.runBackup.mockResolvedValue({ ok: false, month: "2026-10", kind: "not-connected", error: "Google Drive isn't connected." });
    expect(await backUpNow()).toEqual({ ok: false, error: "Google Drive isn't connected." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});

describe("disconnectDrive", () => {
  it("forgets the connection in the console only and audits it", async () => {
    h.removeDriveAccount.mockResolvedValue(true);
    const r = await disconnectDrive();
    expect(r.ok).toBe(true);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Google Drive disconnected", resourceId: null, actorUserId: "user-1" });
    h.removeDriveAccount.mockResolvedValue(false);
    expect(await disconnectDrive()).toEqual({ ok: false, error: "Google Drive isn't connected." });
  });
});
