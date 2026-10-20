import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(),
  setModelEnabled: vi.fn(), refreshProviderModels: vi.fn(), modelRows: vi.fn(), setDefaultModel: vi.fn(), testModels: vi.fn(), syncModelsNow: vi.fn(),
}));
vi.mock("@/private/ai/providers/model-test", () => ({ testModels: h.testModels, SCAN_BUDGET_MS: 50_000 }));
vi.mock("@/private/ai/extras", () => ({ syncModelsNow: h.syncModelsNow }));
const adv = vi.hoisted(() => ({ runAdvisorNotes: vi.fn(), saveAdvisorSettings: vi.fn() }));
vi.mock("@/private/assist/advisor-notes", () => adv);
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/private/ui/deps", () => ({ setModelEnabled: h.setModelEnabled, refreshProviderModels: h.refreshProviderModels }));
vi.mock("@/private/ai/views-db", () => ({ modelRows: h.modelRows, setDefaultModel: h.setDefaultModel }));

import { makeDefaultModel, refreshAllModels, runAdvisorNowAction, scanModelsAction, setAdvisorNotesAction, syncModelsNowAction, testModelAction, toggleModel } from "./actions";

const row = (o: Record<string, unknown> = {}) => ({ providerId: UUID, publicId: "gemini/gemini-3.8-flash", modelId: "gemini-3.8-flash", enabled: true, providerEnabled: true, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.setModelEnabled.mockResolvedValue({ ok: true, message: "ok" });
  h.modelRows.mockResolvedValue({ rows: [row(), row({ publicId: "custom/gpt-x", modelId: "gpt-x" }), row({ publicId: "gemini/off", modelId: "off", enabled: false })], providers: [{ id: UUID, enabled: true }, { id: "p2", enabled: false }] });
});

describe("toggleModel", () => {
  it("is owner only and switches the model", async () => {
    const r = await toggleModel(UUID, "gemini-3.8-flash", false);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.setModelEnabled).toHaveBeenCalledWith(UUID, "gemini-3.8-flash", false);
    expect(r.ok).toBe(true);
    expect(h.refresh).toHaveBeenCalled();
  });
  it("passes on the provider layer's refusal", async () => {
    h.setModelEnabled.mockResolvedValue({ ok: false, error: "That model isn't on this connection's list." });
    expect(await toggleModel(UUID, "m", true)).toEqual({ ok: false, error: "That model isn't on this connection's list." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("refuses bad input and non-owners", async () => {
    expect((await toggleModel("x", "m", true)).ok).toBe(false);
    expect((await toggleModel(UUID, "", true)).ok).toBe(false);
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await toggleModel(UUID, "m", true)).ok).toBe(false);
    expect(h.setModelEnabled).not.toHaveBeenCalled();
  });
});

describe("makeDefaultModel", () => {
  it("stores an enabled Gemini model as the default", async () => {
    const r = await makeDefaultModel("gemini/gemini-3.8-flash");
    expect(r.ok).toBe(true);
    expect(h.setDefaultModel).toHaveBeenCalledWith("gemini/gemini-3.8-flash", expect.any(Date));
  });
  it("refuses a model that is off or unknown", async () => {
    for (const id of ["gemini/off", "gemini/nope"]) expect((await makeDefaultModel(id)).ok, id).toBe(false);
    expect(h.setDefaultModel).not.toHaveBeenCalled();
  });
});

describe("refreshAllModels", () => {
  it("asks each enabled connection", async () => {
    h.refreshProviderModels.mockResolvedValue({ ok: true, message: "ok" });
    expect((await refreshAllModels()).ok).toBe(true);
    expect(h.refreshProviderModels).toHaveBeenCalledTimes(1);
    expect(h.refreshProviderModels).toHaveBeenCalledWith(UUID);
  });
  it("says so when nothing answered", async () => {
    h.refreshProviderModels.mockRejectedValue(new Error("403"));
    expect((await refreshAllModels()).ok).toBe(false);
    h.refreshProviderModels.mockResolvedValue({ ok: false, error: "403" });
    expect((await refreshAllModels()).ok).toBe(false);
  });
  it("says so when no provider is connected", async () => {
    h.modelRows.mockResolvedValue({ rows: [], providers: [] });
    expect((await refreshAllModels()).ok).toBe(false);
  });
});

describe("testModelAction / scanModelsAction (owner 14 Oct)", () => {
  const ok = (id: string, good: boolean) => ({ id, test: good ? { ok: true, ms: 2300, at: "x" } : { ok: false, ms: 10, status: 404, error: "model not found (404)", at: "x" } });
  it.each([["viewer"], ["operator"]])("refuses a %s before the limit or any call", async (role) => {
    h.requireActionMember.mockImplementation(async (need: string) => { if (need === "owner" && role !== "owner") throw new AuthError("forbidden"); return { ...owner, role }; });
    expect((await scanModelsAction(UUID)).ok).toBe(false);
    expect((await testModelAction(UUID, "a")).ok).toBe(false);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.testModels).not.toHaveBeenCalled();
  });
  it("uses the credential-test limit", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await scanModelsAction(UUID)).toEqual({ ok: false, error: "Too many tests. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(expect.objectContaining({ name: "credential" }), "mem-1");
    expect(h.testModels).not.toHaveBeenCalled();
  });
  it("Scan all: every model, then how many answered and how many are left", async () => {
    h.testModels.mockResolvedValue({ ok: true, tested: [ok("a", true), ok("b", false)], skipped: 3 });
    expect(await scanModelsAction(UUID)).toEqual({ ok: true, message: "1 of 2 models answered. 3 not tested yet: run Scan all again.", data: { tested: 2, working: 1, skipped: 3 } });
    expect(h.testModels).toHaveBeenCalledWith(UUID, null);
    expect(h.refresh).toHaveBeenCalled();
  });
  it("Test one: ok with its time, or its short error", async () => {
    h.testModels.mockResolvedValueOnce({ ok: true, tested: [ok("a", true)], skipped: 0 });
    expect(await testModelAction(UUID, "a")).toMatchObject({ ok: true, message: "a works (2.3 s)." });
    expect(h.testModels).toHaveBeenLastCalledWith(UUID, ["a"]);
    h.testModels.mockResolvedValueOnce({ ok: true, tested: [ok("b", false)], skipped: 0 });
    expect(await testModelAction(UUID, "b")).toEqual({ ok: false, error: "b: model not found (404)." });
  });
  it("rejects a malformed provider id or model id", async () => {
    expect((await scanModelsAction("x")).ok).toBe(false);
    expect((await testModelAction(UUID, "")).ok).toBe(false);
    expect(h.testModels).not.toHaveBeenCalled();
  });
});

describe("advisor notes settings and Run now (owner 14 Oct)", () => {
  it.each([["viewer"], ["operator"]])("refuse a %s and touch nothing", async (role) => {
    h.requireActionMember.mockImplementation(async (need: string) => { if (need === "owner" && role !== "owner") throw new AuthError("forbidden"); return { ...owner, role }; });
    expect((await setAdvisorNotesAction(false, null)).ok).toBe(false);
    expect((await runAdvisorNowAction()).ok).toBe(false);
    expect(adv.saveAdvisorSettings).not.toHaveBeenCalled();
    expect(adv.runAdvisorNotes).not.toHaveBeenCalled();
  });
  it("saves on/off and a model that is on; refuses one that isn't", async () => {
    expect((await setAdvisorNotesAction(true, "gemini/gemini-3.8-flash")).ok).toBe(true);
    expect(adv.saveAdvisorSettings).toHaveBeenCalledWith({ enabled: true, model: "gemini/gemini-3.8-flash" });
    expect(await setAdvisorNotesAction(true, "gemini/off")).toEqual({ ok: false, error: "Turn the model on first." });
    expect(await setAdvisorNotesAction(false, null)).toEqual({ ok: true, message: "Advisor notes are off." });
  });
  it("Run now forces a run and reports the count, or why nothing was written", async () => {
    adv.runAdvisorNotes.mockResolvedValueOnce({ status: "written", count: 2, model: "test/prrojects" });
    expect(await runAdvisorNowAction()).toEqual({ ok: true, message: "2 advisor notes written by test/prrojects.", data: { count: 2 } });
    expect(adv.runAdvisorNotes).toHaveBeenCalledWith(expect.any(Date), { force: true, deadlineMs: 45_000 });
    adv.runAdvisorNotes.mockResolvedValueOnce({ status: "skipped", reason: "no-provider" });
    expect(await runAdvisorNowAction()).toEqual({ ok: false, error: "No AI provider is connected." });
    adv.runAdvisorNotes.mockRejectedValueOnce(new Error("sk-secret body"));
    expect(await runAdvisorNowAction()).toEqual({ ok: false, error: "The AI provider couldn't answer. Try again." });
  });
});

describe("syncModelsNowAction", () => {
  const conn = (o: object = {}) => ({ id: UUID, name: "Router A", ok: true, listed: 35, added: [], removed: [], returned: [], tested: 0, ready: [], pending: 0, ...o });
  const sum = (o: object = {}) => ({ listed: 35, added: 0, removed: 0, returned: 0, tested: 0, ready: 0, ...o });
  it("is owner only, uses the credential budget and reports the run", async () => {
    h.syncModelsNow.mockResolvedValue({ conns: [conn()], summary: sum({ added: 2, tested: 3, ready: 2, removed: 1 }), pending: false });
    const r = await syncModelsNowAction();
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).toHaveBeenCalledWith(expect.objectContaining({ name: "credential" }), "mem-1");
    expect(r).toEqual({ ok: true, message: "Synced: 35 listed, 2 new, 1 removed, 3 tested, 2 turned on." });
    expect(h.refresh).toHaveBeenCalled();
  });
  it("says so when no custom server is on, or every one failed", async () => {
    h.syncModelsNow.mockResolvedValue({ conns: [], summary: sum({ listed: 0 }), pending: false });
    expect(await syncModelsNowAction()).toEqual({ ok: false, error: "No custom server is connected and on." });
    h.syncModelsNow.mockResolvedValue({ conns: [conn({ ok: false, error: "the router listed no models" })], summary: sum({ listed: 0 }), pending: false });
    expect(await syncModelsNowAction()).toEqual({ ok: false, error: "Router A: the router listed no models." });
  });
  it("refuses when throttled", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect((await syncModelsNowAction()).ok).toBe(false);
    expect(h.syncModelsNow).not.toHaveBeenCalled();
  });
});
