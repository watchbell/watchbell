import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), connect: vi.fn(), testConnection: vi.fn(), replaceSecret: vi.fn(), removeConnection: vi.fn(), addManualModel: vi.fn(), removeManualModel: vi.fn(), recordEvents: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("./providers-db", () => ({ connect: h.connect, testConnection: h.testConnection, replaceSecret: h.replaceSecret, removeConnection: h.removeConnection, addManualModel: h.addManualModel, removeManualModel: h.removeManualModel }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));

import { addManualModel, connectProvider, removeManualModel, removeProvider, replaceProviderKey, testProvider } from "./actions";

const ID = "123e4567-e89b-42d3-a456-426614174000";
beforeEach(() => {
  h.requireActionMember.mockReset().mockResolvedValue(member);
  h.limit.mockReset().mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.connect.mockReset().mockResolvedValue({ ok: true, message: "ok", data: { id: ID } });
  h.testConnection.mockReset().mockResolvedValue({ ok: true, message: "ok" });
  h.replaceSecret.mockReset().mockResolvedValue({ ok: true, message: "ok", data: { name: "Google Gemini", kind: "gemini" } });
  h.removeConnection.mockReset().mockResolvedValue({ ok: true, message: "ok", data: { name: "Google Gemini", kind: "gemini" } });
  h.addManualModel.mockReset().mockResolvedValue({ ok: true, message: "test answered with prrojects. It is on as test/prrojects.", data: { name: "test" } });
  h.removeManualModel.mockReset().mockResolvedValue({ ok: true, message: "test/prrojects removed.", data: { name: "test" } });
  h.recordEvents.mockReset().mockResolvedValue(undefined);
  h.revalidatePath.mockReset();
});

describe("provider actions", () => {
  it("owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await connectProvider("gemini", { apiKey: "AQ.x" })).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("connect and test share the credential-test limit", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await connectProvider("gemini", { apiKey: "AQ.x" })).toEqual({ ok: false, error: "Too many connection tests. Try again in 5 minutes." });
    expect(await testProvider(ID)).toEqual({ ok: false, error: "Too many connection tests. Try again in 5 minutes." });
    expect(h.limit.mock.calls[0]).toEqual([{ name: "credential", max: 20, windowSeconds: 600 }, "mem-1"]);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("connects and refreshes the AI pages", async () => {
    expect((await connectProvider("gemini", { apiKey: "AQ.x", makeDefault: true })).ok).toBe(true);
    expect(h.connect).toHaveBeenCalledWith("gemini", { apiKey: "AQ.x", makeDefault: true });
    expect(h.revalidatePath).toHaveBeenCalledWith("/ai/providers");
  });
  it("a malformed id never reaches the database", async () => {
    expect(await testProvider("x' or 1=1")).toEqual({ ok: false, error: "That connection no longer exists." });
    expect(h.testConnection).not.toHaveBeenCalled();
  });
});

describe("provider audit events (like API key changes)", () => {
  const KEY = "AQ.Fake0TstKplaintext-secret-000000000";
  const events = () => h.recordEvents.mock.calls.map((c) => c[0][0]);
  it("connect, replace key and remove each write one action event with name and kind, never the key", async () => {
    await connectProvider("gemini", { apiKey: KEY });
    await connectProvider("custom", { apiKey: KEY, name: "My proxy", baseUrl: "https://llm.example.com/v1" });
    await replaceProviderKey(ID, { apiKey: KEY });
    await removeProvider(ID);
    expect(events()).toEqual([
      expect.objectContaining({ type: "action", kind: "ok", reason: "AiProviderConnected", message: "AI provider connected: Google Gemini", detail: "provider gemini", actorUserId: "user-1" }),
      expect.objectContaining({ reason: "AiProviderConnected", message: "AI provider connected: My proxy", detail: "provider custom" }),
      expect.objectContaining({ reason: "AiProviderKeyReplaced", message: "AI provider key replaced: Google Gemini", actorUserId: "user-1" }),
      expect.objectContaining({ reason: "AiProviderRemoved", message: "AI provider removed: Google Gemini", actorUserId: "user-1" }),
    ]);
    expect(JSON.stringify(h.recordEvents.mock.calls)).not.toContain("plaintext-secret");
  });
  it("a failed change writes nothing; a failed audit never fails the change", async () => {
    h.connect.mockResolvedValue({ ok: false, error: "Google denied this project's Gemini API access." });
    h.removeConnection.mockResolvedValue({ ok: false, error: "That connection no longer exists." });
    await connectProvider("gemini", { apiKey: KEY });
    await removeProvider(ID);
    expect(h.recordEvents).not.toHaveBeenCalled();
    h.recordEvents.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await replaceProviderKey(ID, { apiKey: KEY })).ok).toBe(true);
    warn.mockRestore();
  });
});

describe("manual model ids", () => {
  it("owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await addManualModel(ID, "prrojects")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await removeManualModel(ID, "prrojects")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.addManualModel).not.toHaveBeenCalled();
    expect(h.removeManualModel).not.toHaveBeenCalled();
  });
  it("adds a trimmed id, refreshes the AI pages and audits the provider name and model id", async () => {
    expect(await addManualModel(ID, "  prrojects ")).toEqual({ ok: true, message: "test answered with prrojects. It is on as test/prrojects." });
    expect(h.addManualModel).toHaveBeenCalledWith(ID, "prrojects");
    expect(h.revalidatePath).toHaveBeenCalledWith("/ai/models");
    expect(h.recordEvents.mock.calls[0][0][0]).toMatchObject({ type: "action", kind: "ok", reason: "AiModelAdded", message: "AI model added on test: prrojects", detail: "provider custom", actorUserId: "user-1" });
    await removeManualModel(ID, "prrojects");
    expect(h.removeManualModel).toHaveBeenCalledWith(ID, "prrojects");
    expect(h.recordEvents.mock.calls[1][0][0]).toMatchObject({ reason: "AiModelRemoved", message: "AI model removed from test: prrojects", actorUserId: "user-1" });
  });
  it("uses the write limit (monitorWrite-style)", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await addManualModel(ID, "prrojects")).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(await removeManualModel(ID, "prrojects")).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.limit.mock.calls[0]).toEqual([{ name: "monitor-write", max: 60, windowSeconds: 600 }, "mem-1"]);
    expect(h.addManualModel).not.toHaveBeenCalled();
  });
  it("bad ids and ids never reach the store; a refusal writes no audit event", async () => {
    for (const bad of ["", "has space", "x".repeat(121), "a;b", 42 as unknown as string]) {
      expect(await addManualModel(ID, bad), String(bad)).toEqual({ ok: false, error: "Use 1–120 letters, digits or . _ : / @ - for the model id." });
    }
    expect(await addManualModel("nope", "prrojects")).toEqual({ ok: false, error: "That connection no longer exists." });
    expect(h.addManualModel).not.toHaveBeenCalled();
    h.addManualModel.mockResolvedValue({ ok: false, error: "The server refused that model: test doesn't know this model (404)." });
    expect(await addManualModel(ID, "prrojects")).toEqual({ ok: false, error: "The server refused that model: test doesn't know this model (404)." });
    expect(h.recordEvents).not.toHaveBeenCalled();
  });
});
