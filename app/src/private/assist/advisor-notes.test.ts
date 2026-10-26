import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenConnection } from "@/private/ai/providers/adapter";

// The always-covered app is configuration (advisor-config.ts); this test uses its own.
vi.mock("./advisor-config", () => ({ ALWAYS_APP: "main-site" }));
const MAIN = "main-site";

const h = vi.hoisted(() => ({
  settingsValue: undefined as unknown, claimed: true, executes: [] as string[], inserts: [] as unknown[],
  openConnections: vi.fn(), resolveModel: vi.fn(), consoleSnapshot: vi.fn(), insertNote: vi.fn(), appRefs: vi.fn(), recordCall: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => { void fn(); } }));
vi.mock("@/db/client", () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.settingsValue === undefined ? [] : [{ value: h.settingsValue }]) }) }) }),
    insert: () => ({ values: (v: unknown) => ({ onConflictDoUpdate: async () => { h.inserts.push(v); } }) }),
    execute: async (q: { queryChunks?: unknown[] }) => { h.executes.push(JSON.stringify(q.queryChunks ?? "")); return h.claimed ? [{ claimed: 1 }] : []; },
  }),
}));
vi.mock("@/private/ai/providers/providers-db", () => ({ openConnections: h.openConnections, consoleDefaultModel: async () => null, resolveModel: h.resolveModel }));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: vi.fn() }));
vi.mock("@/private/ai/usage", async (orig) => ({ ...(await orig<typeof import("@/private/ai/usage")>()), recordCall: h.recordCall }));
vi.mock("@/private/console/snapshot", () => ({ consoleSnapshot: h.consoleSnapshot }));
vi.mock("@/private/mcp/notes-db", () => ({ insertNote: h.insertNote }));
vi.mock("@/private/mcp/data", () => ({ appRefs: h.appRefs, resolveApp: (refs: { id: string; name: string }[], n: string) => refs.find((r) => r.name === n) ?? null }));

import { advisorMinuteStep, runAdvisorNotes } from "./advisor-notes";

const server = setupServer(http.all("*", () => HttpResponse.error()));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://router.example.test/v1";
const conn = { id: "p1", slug: "test", kind: "custom", name: "test", enabled: true, isDefault: true, baseUrl: BASE, secret: { apiKey: "sk-test-00000000" }, limits: [], updatedAt: new Date(0),
  models: [{ id: "prrojects", upstream: "prrojects", enabled: true, manual: true }] } as OpenConnection;
const IN = new Date("2026-10-14T00:03:00.000Z"); // 07:03 WIB
const OUT = new Date("2026-10-14T05:00:00.000Z"); // 12:00 WIB
const snap = {
  generatedAt: IN.toISOString(), monitors: { up: 1, degraded: 0, down: 1, paused: 0 }, alerts: { open: 0, critical: 0 },
  apps: [{ id: MAIN, state: "running", uptime30d: 99.9, database: null, lastDeploy: null, problems: [] }, { id: "web-a", state: "down", uptime30d: 90, database: null, lastDeploy: null, problems: [] }],
};
const notes = { notes: [
  { app: MAIN, severity: "info", title: "Portfolio is healthy", body: "Uptime is 99.9% this month. Keep the weekly dependency update." },
  { app: "web-a", severity: "crit", title: "web-a is down", body: "The monitor fails. Roll back the last deploy first." },
  { app: "web-x", severity: "warn", title: "Unknown", body: "This app was not asked about at all here." },
] };
let calls = 0;
const provider = (content: string, delayMs = 0) => server.use(http.post(`${BASE}/chat/completions`, async () => {
  calls++;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  return HttpResponse.json({ choices: [{ message: { content } }] });
}));

beforeEach(() => {
  calls = 0;
  h.settingsValue = undefined;
  h.claimed = true;
  h.executes.length = 0;
  h.inserts.length = 0;
  h.openConnections.mockReset().mockResolvedValue([conn]);
  h.resolveModel.mockReset();
  h.consoleSnapshot.mockReset().mockResolvedValue(snap);
  h.insertNote.mockReset().mockResolvedValue({ ok: true, id: "n1" });
  h.appRefs.mockReset().mockResolvedValue([{ id: "uuid-portfolio", name: MAIN }, { id: "uuid-a", name: "web-a" }]);
  h.recordCall.mockReset().mockResolvedValue(undefined);
});

describe("runAdvisorNotes", () => {
  it("with its own model set, a down provider still falls back to another enabled one (owner item #19)", async () => {
    const backup = { ...conn, id: "p2", slug: "backup", name: "Backup", isDefault: false, baseUrl: "https://backup.example.test/v1", models: [{ id: "b-1", upstream: "b-1", enabled: true }] } as OpenConnection;
    h.openConnections.mockResolvedValue([conn, backup]);
    h.resolveModel.mockResolvedValue({ conn, upstream: "prrojects", publicId: "test/prrojects" });
    h.settingsValue = { enabled: true, model: "test/prrojects" };
    server.use(
      http.post(`${BASE}/chat/completions`, () => new HttpResponse(null, { status: 530 })),
      http.post("https://backup.example.test/v1/chat/completions", () => HttpResponse.json({ choices: [{ message: { content: JSON.stringify(notes) } }] })),
    );
    expect(await runAdvisorNotes(IN)).toEqual({ status: "written", count: 2, model: "backup/b-1" });
  });

  it("in the window: claims the marker, one provider call, writes the valid notes as watchpost with the provider model", async () => {
    provider(JSON.stringify(notes));
    expect(await runAdvisorNotes(IN)).toEqual({ status: "written", count: 2, model: "test/prrojects" });
    expect(calls).toBe(1);
    expect(h.executes).toHaveLength(1); // the claim
    expect(h.executes[0]).toContain("2026-10-14T07");
    expect(h.insertNote).toHaveBeenCalledTimes(2);
    expect(h.insertNote).toHaveBeenCalledWith(
      { title: "web-a is down", body: expect.any(String), severity: "crit", appId: "uuid-a", model: "test/prrojects", client: "watchpost" }, null, "watchpost", IN,
    );
  });
  it("outside the window: reads nothing, calls nothing", async () => {
    expect(await runAdvisorNotes(OUT)).toEqual({ status: "skipped", reason: "outside-window" });
    expect(h.openConnections).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });
  it("switched off: skipped before the provider and the marker", async () => {
    h.settingsValue = { enabled: false, model: null };
    expect(await runAdvisorNotes(IN)).toEqual({ status: "skipped", reason: "off" });
    expect(h.executes).toHaveLength(0);
  });
  it("no provider connected: skipped silently, no marker written", async () => {
    h.openConnections.mockResolvedValue([]);
    expect(await runAdvisorNotes(IN)).toEqual({ status: "skipped", reason: "no-provider" });
    expect(h.executes).toHaveLength(0);
  });
  it("another run already holds this window's marker: no provider call (no double notes)", async () => {
    h.claimed = false;
    expect(await runAdvisorNotes(IN)).toEqual({ status: "skipped", reason: "already-ran" });
    expect(calls).toBe(0);
    expect(h.insertNote).not.toHaveBeenCalled();
  });
  it("an answer without a valid note writes nothing", async () => {
    provider("Sorry, I can't.");
    expect(await runAdvisorNotes(IN)).toEqual({ status: "skipped", reason: "no-valid-notes" });
    expect(h.insertNote).not.toHaveBeenCalled();
  });
  it("Run now (force): any time, no marker, even when switched off", async () => {
    h.settingsValue = { enabled: false, model: null };
    provider(JSON.stringify(notes));
    expect((await runAdvisorNotes(OUT, { force: true })).status).toBe("written");
    expect(h.executes).toHaveLength(0);
  });
  it("stops waiting at its deadline", async () => {
    provider(JSON.stringify(notes), 300);
    await expect(runAdvisorNotes(IN, { deadlineMs: 50 })).rejects.toThrow("advisor deadline");
    expect(h.insertNote).not.toHaveBeenCalled();
  });
});

describe("advisorMinuteStep (from the per-minute collector)", () => {
  it("never throws: a provider failure is a log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(advisorMinuteStep(IN)).resolves.toBeUndefined(); // catch-all MSW = network failure
    expect(warn).toHaveBeenCalledWith("advisor notes failed:", expect.any(String));
    warn.mockRestore();
    log.mockRestore();
  });
  it("does nothing at all outside the window", async () => {
    await advisorMinuteStep(OUT);
    expect(h.openConnections).not.toHaveBeenCalled();
  });
});
