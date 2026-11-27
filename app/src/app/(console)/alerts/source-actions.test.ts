import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const T = "am_8f2kQwErTyUiPaSdFgHjKz";
const SRC = { id: "s1", kind: "alertmanager", name: "Alertmanager", tokenHash: "h", tokenPrefix: "am_8f2k", enabled: true, createdAt: new Date("2026-11-20T00:00:00Z"), lastSeenAt: null as Date | null, monthKey: null, receivedMonth: 0, refusedMonth: 0 };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(),
  createSource: vi.fn(), revokeSources: vi.fn(), readSources: vi.fn(), applyExternalAlerts: vi.fn(), recentExternal: vi.fn(), deliverPending: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://ops.kopisenja.example/" }) }));
vi.mock("@/lib/data/ingest-db", () => ({
  TEST_SUBJECT: "am:watchbell-test", createSource: h.createSource, revokeSources: h.revokeSources, readSources: h.readSources,
  applyExternalAlerts: h.applyExternalAlerts, recentExternal: h.recentExternal,
}));
vi.mock("@/lib/data/notify-db", () => ({ deliverPending: h.deliverPending }));

import { INGEST_TOKEN } from "@/lib/ingest/token";
import { revokeSourceAction, sendTestAlertAction, setupSourceAction, sourceStatusAction } from "./source-actions";

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.createSource.mockResolvedValue({ token: T, prefix: "am_8f2k", id: "s1" });
  h.readSources.mockResolvedValue([SRC]);
  h.revokeSources.mockResolvedValue(1);
  h.applyExternalAlerts.mockResolvedValue({ opened: 1, touched: 0, resolved: 0 });
  h.recentExternal.mockResolvedValue([{ title: "HighErrorRate · pos-api", status: "firing", at: new Date() }]);
  h.deliverPending.mockResolvedValue({ sent: 1, dropped: 0 });
});

describe("Alerts › Sources actions", () => {
  it("refuses anyone but an owner, before any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    const forbidden = { ok: false, error: "You don't have permission to do that." };
    expect(await setupSourceAction()).toEqual(forbidden);
    expect(await revokeSourceAction()).toEqual(forbidden);
    expect(await sendTestAlertAction()).toEqual(forbidden);
    expect(await sourceStatusAction(new Date().toISOString())).toEqual(forbidden);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.createSource).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it("does nothing in the demo", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    expect(await setupSourceAction()).toEqual({ ok: false, error: "Not available in the demo" });
    expect(h.createSource).not.toHaveBeenCalled();
  });

  it("sets up a source and shows the URL once; the audit line never holds the token", async () => {
    const r = await setupSourceAction();
    expect(r).toMatchObject({ ok: true, data: { url: `https://ops.kopisenja.example/api/alertmanager/${T}`, prefix: "am_8f2k" } });
    expect(r.ok && r.data!.url.split("/").pop()).toMatch(INGEST_TOKEN);
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain(T);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", message: "Alertmanager source set up (am_8f2k…)" }));
    expect(h.refresh).toHaveBeenCalled();
  });

  it("refuses too many changes", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await setupSourceAction()).toMatchObject({ ok: false, error: expect.stringMatching(/Too many changes/) });
    expect(h.createSource).not.toHaveBeenCalled();
  });

  it("revokes every enabled source, and says so when there is none", async () => {
    expect(await revokeSourceAction()).toMatchObject({ ok: true });
    expect(h.revokeSources).toHaveBeenCalledWith("alertmanager");
    h.revokeSources.mockResolvedValue(0);
    expect(await revokeSourceAction()).toEqual({ ok: false, error: "There's no Alertmanager source to revoke." });
  });

  it("sends an info test alert through the same path, and refuses without a source", async () => {
    expect(await sendTestAlertAction()).toMatchObject({ ok: true });
    const [, input] = h.applyExternalAlerts.mock.calls[0];
    expect(input).toEqual([expect.objectContaining({ subject: "am:watchbell-test", status: "firing", severity: "info", title: "WatchbellTest" })]);
    expect(h.deliverPending).toHaveBeenCalled();
    h.readSources.mockResolvedValue([]);
    expect(await sendTestAlertAction()).toEqual({ ok: false, error: "Set up Alertmanager first." });
  });

  it("tells the wizard whether Alertmanager posted after a moment; only the route sets last seen", async () => {
    const since = "2026-11-25T10:00:00.000Z";
    expect(await sourceStatusAction(since)).toEqual({ ok: true, data: { received: false } });
    h.readSources.mockResolvedValue([{ ...SRC, lastSeenAt: new Date("2026-11-25T10:00:30Z") }]);
    expect(await sourceStatusAction(since)).toEqual({ ok: true, data: { received: true, title: "HighErrorRate · pos-api" } });
    expect(await sourceStatusAction("not a date")).toMatchObject({ ok: false });
    expect(h.limit).not.toHaveBeenCalled();
  });
});
