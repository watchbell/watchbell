import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./monitors-db", () => ({ updateMonitor: vi.fn() }));

import { moveMonitorToDomain } from "./monitor-move-db";

const meta = { domains: ["finance.example.com"], primaryDomain: "finance.example.com" };
const mon = (o: Record<string, unknown> = {}) => ({
  id: "m1", resourceId: "a1", kind: "http", url: "https://old-finance.example.net/api/health?deep=1", expectedStatus: 200, timeoutMs: 10_000,
  bodyContains: "ok", jsonPath: null, jsonEquals: null, lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND", ...o,
});

beforeEach(() => { h.current = null; });

describe("moveMonitorToDomain (1.2.1)", () => {
  it("points the monitor at the app's primary domain, keeping the path, query and check settings", async () => {
    h.current = fakeDb([[{ m: mon(), appName: "shopfront", appMeta: meta }], []]);
    const update = vi.fn().mockResolvedValue({ ok: true, message: "saved" });
    const r = await moveMonitorToDomain("m1", update);
    expect(update).toHaveBeenCalledWith("m1", {
      url: "https://finance.example.com/api/health?deep=1", expectedStatus: 200, timeoutMs: 10_000, bodyContains: "ok", jsonPath: null, jsonEquals: null,
    });
    expect(r).toEqual({
      ok: true, message: "Monitor now checks https://finance.example.com/api/health?deep=1.",
      audit: { message: "Monitor moved to the app's new domain: finance.example.com/api/health", detail: "was old-finance.example.net/api/health", resourceId: "a1" },
    });
  });
  it("changes nothing when the host is attached (here: another watched project lists it), for a heartbeat or a missing monitor", async () => {
    const update = vi.fn();
    h.current = fakeDb([[{ m: mon(), appName: "shopfront", appMeta: meta }], [{ id: "a2", name: "old", meta: { domains: ["old-finance.example.net"], primaryDomain: "old-finance.example.net" } }]]);
    expect(await moveMonitorToDomain("m1", update)).toMatchObject({ ok: false, error: expect.stringMatching(/nothing to update/) });
    // a non-Vercel host the project never listed: no evidence, no move
    h.current = fakeDb([[{ m: mon({ url: "https://api.mybackend.com/", lastError: "HTTP 502" }), appName: "shopfront", appMeta: meta }], []]);
    expect(await moveMonitorToDomain("m1", update)).toMatchObject({ ok: false });
    h.current = fakeDb([[{ m: mon({ kind: "heartbeat" }), appName: "x", appMeta: meta }]]);
    expect(await moveMonitorToDomain("m1", update)).toMatchObject({ ok: false });
    h.current = fakeDb([[]]);
    expect(await moveMonitorToDomain("m1", update)).toEqual({ ok: false, error: "That monitor no longer exists." });
    expect(update).not.toHaveBeenCalled();
  });
  it("passes a refusal of the edit on (a duplicate address)", async () => {
    h.current = fakeDb([[{ m: mon(), appName: "shopfront", appMeta: meta }], []]);
    const update = vi.fn().mockResolvedValue({ ok: false, error: "dup" });
    expect(await moveMonitorToDomain("m1", update)).toEqual({ ok: false, error: "dup" });
  });
});
