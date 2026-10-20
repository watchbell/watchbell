import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), modelRows: vi.fn(), runComplete: vi.fn(), snapshotJson: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/private/ai/views-db", () => ({ modelRows: h.modelRows }));
vi.mock("@/private/ui/deps", () => ({ runComplete: h.runComplete, snapshotJson: h.snapshotJson }));

import { LIMITS } from "@/private/ui/limits";
import { playgroundSend } from "./actions";
import { DEFAULT_SYSTEM, parsePlayground, safeMessage } from "./input";

const input = (o: Record<string, unknown> = {}) => ({
  model: "", mode: "plain", temperature: 0.4, maxTokens: 1024, system: "", messages: [{ role: "user", content: "Which apps need attention?" }], ...o,
});
const model = (o: Record<string, unknown> = {}) => ({ providerId: "p1", publicId: "gemini/gemini-3.8-flash", modelId: "gemini-3.8-flash", enabled: true, providerEnabled: true, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.modelRows.mockResolvedValue({ rows: [model(), model({ publicId: "gemini/gemini-3.5-flash", modelId: "gemini-3.5-flash", enabled: false })], defaultModel: null });
  h.runComplete.mockResolvedValue({ text: "Two apps.", model: "gemini/gemini-3.8-flash", usage: { in: 1840, out: 96 }, ms: 1400 });
  h.snapshotJson.mockResolvedValue('{"apps":[{"id":"app-a","state":"down"}]}');
});

describe("parsePlayground", () => {
  it("accepts a normal request", () => {
    expect(parsePlayground(input()).ok).toBe(true);
  });
  it("rejects bad numbers, modes and conversations", () => {
    for (const bad of [
      input({ mode: "x" }), input({ temperature: 3 }), input({ temperature: "abc" }), input({ maxTokens: 5 }), input({ maxTokens: 1.5 }), input({ maxTokens: 100_000 }),
      input({ system: "x".repeat(4001) }), input({ messages: [] }), input({ messages: [{ role: "assistant", content: "hi" }] }),
      input({ messages: [{ role: "system", content: "x" }] }), input({ messages: [{ role: "user", content: "   " }] }),
      input({ messages: [{ role: "user", content: "x".repeat(8001) }] }),
      input({ messages: Array.from({ length: 21 }, () => ({ role: "user", content: "a" })) }),
      input({ messages: Array.from({ length: 6 }, () => ({ role: "user", content: "x".repeat(7500) })) }),
      null, "x",
    ]) expect(parsePlayground(bad).ok).toBe(false);
  });
});

describe("safeMessage", () => {
  it("shows a short plain message, hides anything key-like", () => {
    expect(safeMessage(new Error("Google denied this project's Gemini API access."), "f")).toBe("Google denied this project's Gemini API access.");
    for (const m of ["failed with key AIzaSyAAAA", "key wb_abc", "key wp_abc", "Bearer abc", "see https://x.y", "mail a@b.c", "x".repeat(300), ""]) expect(safeMessage(new Error(m), "fallback")).toBe("fallback");
    expect(safeMessage("nope", "fallback")).toBe("fallback");
  });
});

describe("playgroundSend", () => {
  it("is owner only and refuses others before anything is called", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await playgroundSend(input())).ok).toBe(false);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.runComplete).not.toHaveBeenCalled();
  });

  it("plain mode: system prompt + the conversation, the playground purpose, the default model", async () => {
    const r = await playgroundSend(input());
    expect(h.limit).toHaveBeenCalledWith(LIMITS.playground, "mem-1");
    expect(h.runComplete).toHaveBeenCalledWith(
      [{ role: "system", content: DEFAULT_SYSTEM }, { role: "user", content: "Which apps need attention?" }],
      { model: "gemini/gemini-3.8-flash", maxTokens: 1024, temperature: 0.4, purpose: "playground" },
    );
    expect(h.snapshotJson).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, data: { text: "Two apps.", model: "gemini/gemini-3.8-flash", tokensIn: 1840, tokensOut: 96, ms: 1400, grounded: false } });
  });

  it("console mode prepends the snapshot as a second system message", async () => {
    const r = await playgroundSend(input({ mode: "console", system: "Be brief." }));
    const msgs = h.runComplete.mock.calls[0][0];
    expect(msgs[0]).toEqual({ role: "system", content: "Be brief." });
    expect(msgs[1].role).toBe("system");
    expect(msgs[1].content).toContain('"apps"');
    expect(msgs[2]).toEqual({ role: "user", content: "Which apps need attention?" });
    expect(r.ok && r.data?.grounded).toBe(true);
  });

  it("only offers models that are on", async () => {
    expect((await playgroundSend(input({ model: "gemini/gemini-3.5-flash" }))).ok).toBe(false);
    expect((await playgroundSend(input({ model: "gpt-4o" }))).ok).toBe(false);
    h.modelRows.mockResolvedValue({ rows: [model({ enabled: false })], defaultModel: null });
    const none = await playgroundSend(input());
    expect(none.ok).toBe(false);
    expect(h.runComplete).not.toHaveBeenCalled();
  });

  it("stops at the rate limit, before reading models or calling", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect((await playgroundSend(input())).ok).toBe(false);
    expect(h.modelRows).not.toHaveBeenCalled();
  });

  it("a failing provider becomes a short message, never a body or a key", async () => {
    h.runComplete.mockRejectedValue(new Error("upstream said AIzaSyDEADBEEF is invalid"));
    const r = await playgroundSend(input());
    expect(r).toEqual({ ok: false, error: "The provider didn't answer. Check the connection under Bring your own key." });
  });
});
