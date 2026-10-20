import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSIST_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const snap = { id: "orbit-blog", state: "down" as const, uptime30d: 99, database: "db-a", lastDeploy: null, problems: [{ kind: "monitor", where: "Monitor /", what: "HTTP 502", fix: "Roll back." }] };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(),
  provider: vi.fn(), appSnapshot: vi.fn(), advice: vi.fn(), complete: vi.fn(), enqueue: vi.fn(), questionForOwner: vi.fn(), refreshSummary: vi.fn(), readAgSettings: vi.fn(),
  answerWithProvider: vi.fn(), loadAskContext: vi.fn(), storeAnswered: vi.fn(),
}));
vi.mock("@/private/ai/extras", async (orig) => ({ ...(await orig<typeof import("@/private/ai/extras")>()), readAgSettings: h.readAgSettings }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("./ports", () => ({ ports: { provider: h.provider, appSnapshot: h.appSnapshot, advice: h.advice, complete: h.complete } }));
vi.mock("./questions-db", () => ({ enqueue: h.enqueue, questionForOwner: h.questionForOwner, storeAnswered: h.storeAnswered }));
vi.mock("./provider-answer", () => ({ answerWithProvider: h.answerWithProvider, loadAskContext: h.loadAskContext, WATCHPOST_CLIENT: "watchpost" }));
vi.mock("./summary", () => ({ refreshSummary: h.refreshSummary }));

import { askAntigravity, askGeneral, askWhy, questionStatus, regenerateSummary } from "./actions";

const AG_ON = { agConnected: true, agEnabled: ["gemini-3.8-flash-high"], providerReady: true };
const AG_OFF = { agConnected: false, agEnabled: [], providerReady: true };
const INVALID = { ok: false, error: "Something in that request wasn't valid." };
const FORBIDDEN = { ok: false, error: "You don't have permission to do that." };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.provider.mockResolvedValue({ name: "Gemini", model: "gemini/gemini-3.8-flash" });
  h.appSnapshot.mockResolvedValue(snap);
  h.complete.mockResolvedValue({ text: "  Roll back first.  ", model: "gemini/gemini-3.8-flash", ms: 1200 });
  h.enqueue.mockResolvedValue({ ok: true, id: "q1", reused: false });
  h.recordAction.mockResolvedValue(undefined);
  h.loadAskContext.mockResolvedValue(AG_ON);
  h.answerWithProvider.mockResolvedValue({ text: "Roll back.", model: "test/prrojects", ms: 24000 });
  h.storeAnswered.mockResolvedValue({ id: "a1" });
});

describe("owner only (R2): every action asks for the owner role before anything else", () => {
  it.each([
    ["askWhy", () => askWhy(APP)],
    ["askAntigravity", () => askAntigravity(APP)],
    ["askGeneral", () => askGeneral("Anything expiring this week?")],
    ["regenerateSummary", () => regenerateSummary()],
    ["questionStatus", () => questionStatus(APP)],
  ])("%s denies a non-owner and touches nothing", async (_n, call) => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await call()).toEqual(FORBIDDEN);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.appSnapshot).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.refreshSummary).not.toHaveBeenCalled();
  });

  it("a signed-out caller gets the session message", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("signed-out"));
    expect(await askWhy(APP)).toEqual({ ok: false, error: "Your session ended. Sign in again." });
  });
});

describe("rate limit: 20 per 600 s per member", () => {
  it.each([
    ["askWhy", () => askWhy(APP)],
    ["askAntigravity", () => askAntigravity(APP)],
    ["askGeneral", () => askGeneral("Anything expiring this week?")],
    ["regenerateSummary", () => regenerateSummary()],
  ])("%s", async (_n, call) => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await call()).toEqual({ ok: false, error: "Too many AI requests. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith({ name: "ai-assist", max: 20, windowSeconds: 600 }, "mem-1");
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.refreshSummary).not.toHaveBeenCalled();
  });
});

describe("askWhy (answer now)", () => {
  it("rejects a malformed app id before the limit", async () => {
    expect(await askWhy("nope")).toEqual(INVALID);
    expect(h.limit).not.toHaveBeenCalled();
  });
  it("needs a connected provider", async () => {
    h.provider.mockResolvedValue(null);
    const r = await askWhy(APP);
    expect(r.ok).toBe(false);
    expect(h.complete).not.toHaveBeenCalled();
  });
  it("says so when the app is unknown", async () => {
    h.appSnapshot.mockResolvedValue(null);
    expect(await askWhy(APP)).toEqual({ ok: false, error: "That application wasn't found." });
  });
  it("sends only the scrubbed why prompt and returns text, model and time", async () => {
    const r = await askWhy(APP);
    expect(r).toEqual({ ok: true, data: { text: "Roll back first.", model: "gemini/gemini-3.8-flash", ms: 1200 } });
    const [messages, opts] = h.complete.mock.calls[0];
    expect(opts).toMatchObject({ purpose: "ask-ai" });
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("HTTP 502");
    expect(h.appSnapshot).toHaveBeenCalledWith(APP, expect.any(Date));
  });
  it("shows a gateway error's curated message, and hides anything else", async () => {
    const gw = Object.assign(new Error("Google denied this project's Gemini API access."), { name: "GatewayError" });
    h.complete.mockRejectedValueOnce(gw);
    expect(await askWhy(APP)).toEqual({ ok: false, error: "Google denied this project's Gemini API access." });
    h.complete.mockRejectedValueOnce(new Error("401 key AIzaSySecret123456 rejected"));
    const r = await askWhy(APP);
    expect(r).toEqual({ ok: false, error: "The AI provider couldn't answer. Try again." });
  });
  it("treats an empty completion as a failure", async () => {
    h.complete.mockResolvedValue({ text: "  ", model: "m", ms: 1 });
    expect((await askWhy(APP)).ok).toBe(false);
  });
});

describe("askAntigravity while Antigravity is connected (inbox)", () => {
  it("rejects a malformed app id", async () => {
    expect(await askAntigravity("../../x")).toEqual(INVALID);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("works without any provider and enqueues the scrubbed question for the app, audited", async () => {
    h.loadAskContext.mockResolvedValue({ ...AG_ON, providerReady: false });
    const r = await askAntigravity(APP);
    expect(r.ok).toBe(true);
    expect(h.answerWithProvider).not.toHaveBeenCalled();
    const arg = h.enqueue.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "app", contextId: APP, by: "user-1" });
    expect(arg.question).toContain("orbit-blog");
    expect(arg.question).toContain("HTTP 502");
    expect(arg.question).not.toMatch(/@|:\/\//);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", resourceId: APP, actorUserId: "user-1" }));
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("does not audit again when the question was already waiting", async () => {
    h.enqueue.mockResolvedValue({ ok: true, id: "q0", reused: true });
    const r = await askAntigravity(APP);
    expect(r).toEqual({ ok: true, message: ASSIST_COPY.alreadyWaiting, data: { id: "q0", status: "pending" } });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("passes the inbox's refusal on", async () => {
    h.enqueue.mockResolvedValue({ ok: false, error: "20 questions are already waiting for Antigravity. Let it answer some first." });
    expect(await askAntigravity(APP)).toEqual({ ok: false, error: "20 questions are already waiting for Antigravity. Let it answer some first." });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("an audit failure does not undo the question", async () => {
    h.recordAction.mockRejectedValue(new Error("db"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await askAntigravity(APP)).ok).toBe(true);
  });
  it("says so when the app is unknown", async () => {
    h.appSnapshot.mockResolvedValue(null);
    expect(await askAntigravity(APP)).toEqual({ ok: false, error: "That application wasn't found." });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("askAntigravity while Antigravity is NOT connected (owner 14 Oct: the provider answers)", () => {
  beforeEach(() => { h.loadAskContext.mockResolvedValue(AG_OFF); });
  it("answers with the provider right away and stores the answered question for the app", async () => {
    const r = await askAntigravity(APP);
    expect(r).toEqual({ ok: true, message: "Answered by test/prrojects in 24.0 s.", data: { id: "a1", status: "answered", text: "Roll back.", model: "test/prrojects", ms: 24000 } });
    expect(h.answerWithProvider.mock.calls[0][0]).toContain("orbit-blog");
    expect(h.storeAnswered).toHaveBeenCalledWith(expect.objectContaining({
      kind: "app", contextId: APP, by: "user-1", answer: "Roll back.", client: "watchpost", model: "test/prrojects", askedAt: expect.any(Date), answeredAt: expect.any(Date),
    }));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("a provider error shows the curated message and stores nothing", async () => {
    h.answerWithProvider.mockRejectedValue(Object.assign(new Error("test answered 429: rate limited."), { name: "GatewayError" }));
    expect(await askAntigravity(APP)).toEqual({ ok: false, error: "test answered 429: rate limited." });
    expect(h.storeAnswered).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("no provider and no Antigravity: a clear error, nothing stored", async () => {
    h.loadAskContext.mockResolvedValue({ ...AG_OFF, providerReady: false });
    expect(await askAntigravity(APP)).toEqual({ ok: false, error: "No AI provider is connected. Connect one under AI Gateway › Bring your own key." });
    expect(h.storeAnswered).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("regenerateSummary", () => {
  it("forces a new summary and refreshes the page", async () => {
    h.refreshSummary.mockResolvedValue({ status: "stored" });
    expect(await regenerateSummary()).toEqual({ ok: true, message: "Summary updated." });
    expect(h.refreshSummary).toHaveBeenCalledWith(expect.any(Date), { force: true });
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("explains when there is no provider or nothing to summarise", async () => {
    h.refreshSummary.mockResolvedValueOnce({ status: "no-provider" });
    expect(await regenerateSummary()).toEqual({ ok: false, error: "No AI provider is connected." });
    h.refreshSummary.mockResolvedValueOnce({ status: "empty" });
    expect(await regenerateSummary()).toEqual({ ok: false, error: "There are no recommendations to summarise." });
  });
  it("hides an unexpected error's text", async () => {
    h.refreshSummary.mockRejectedValue(new Error("secret AQ.abc123456 failed"));
    expect(await regenerateSummary()).toEqual({ ok: false, error: "The AI provider couldn't answer. Try again." });
  });
});

describe("askGeneral (AI › Ask)", () => {
  it.each([["viewer"], ["operator"]])("refuses a %s before anything else", async (role) => {
    h.requireActionMember.mockImplementation(async (need: string) => {
      if (need === "owner" && role !== "owner") throw new AuthError("forbidden");
      return { ...member, role };
    });
    expect(await askGeneral("Anything expiring?")).toEqual(FORBIDDEN);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ["empty", "", "Type a question first."],
    ["blank", "   \n  ", "Type a question first."],
    ["not text", 42 as unknown as string, "Type a question first."],
    ["too long", "x".repeat(2001), "A question can be up to 2000 characters."],
    ["a key", "why does wp_AbCdEf1234567890xyz fail?", "That looks like a key or token. Remove it before sending."],
    ["a bearer token", "Authorization: Bearer abcdefghijklmnopqrstu", "That looks like a key or token. Remove it before sending."],
  ])("refuses %s text and stores nothing", async (_n, q, error) => {
    expect(await askGeneral(q)).toEqual({ ok: false, error });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("Default: the provider answers a trimmed general question right away; stored answered, then refresh", async () => {
    const r = await askGeneral("  Which apps need attention?  ");
    expect(r).toEqual({ ok: true, message: "Answered by test/prrojects in 24.0 s.", data: { id: "a1", status: "answered", text: "Roll back.", model: "test/prrojects", ms: 24000 } });
    expect(h.answerWithProvider).toHaveBeenCalledWith("Which apps need attention?", { model: undefined, now: expect.any(Date) });
    expect(h.storeAnswered).toHaveBeenCalledWith(expect.objectContaining({ kind: "general", contextId: null, question: "Which apps need attention?", by: "user-1", client: "watchpost", model: "test/prrojects" }));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("accepts exactly 2000 characters", async () => {
    expect((await askGeneral("y".repeat(2000))).ok).toBe(true);
  });
  it("a provider error: the curated message, nothing stored, nothing queued", async () => {
    h.answerWithProvider.mockRejectedValue(Object.assign(new Error("No model is turned on for test. Turn one on under Models."), { name: "GatewayError" }));
    expect(await askGeneral("q?")).toEqual({ ok: false, error: "No model is turned on for test. Turn one on under Models." });
    h.answerWithProvider.mockRejectedValue(new Error("upstream body with sk-abc"));
    expect(await askGeneral("q?")).toEqual({ ok: false, error: "The AI provider couldn't answer. Try again." });
    expect(h.storeAnswered).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("a provider model id goes to that model, whether or not Antigravity is connected", async () => {
    for (const ctx of [AG_ON, AG_OFF]) {
      h.loadAskContext.mockResolvedValue(ctx);
      expect((await askGeneral("Hi?", "test/prrojects")).ok).toBe(true);
      expect(h.answerWithProvider).toHaveBeenLastCalledWith("Hi?", { model: "test/prrojects", now: expect.any(Date) });
    }
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("askGeneral with an Antigravity model", () => {
  it("connected and on: queued in the inbox with that model, given as id or ag/ id, audited", async () => {
    for (const m of ["gemini-3.8-flash-high", "ag/gemini-3.8-flash-high"]) {
      expect(await askGeneral("Hi?", m), m).toEqual({ ok: true, message: ASSIST_COPY.sentGeneral, data: { id: "q1", status: "pending" } });
      expect(h.enqueue).toHaveBeenLastCalledWith({ kind: "general", contextId: null, question: "Hi?", by: "user-1", now: expect.any(Date), model: "gemini-3.8-flash-high" });
    }
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: ASSIST_COPY.queuedAudit("general"), resourceId: null, actorUserId: "user-1" });
    expect(h.answerWithProvider).not.toHaveBeenCalled();
  });
  it("not connected, or a model that is off: refused before the quota and the inbox", async () => {
    h.loadAskContext.mockResolvedValue(AG_OFF);
    expect(await askGeneral("Hi?", "ag/gemini-3.8-flash-high")).toEqual({ ok: false, error: "That model isn't available. Pick another one or Default." });
    h.loadAskContext.mockResolvedValue(AG_ON);
    expect(await askGeneral("Hi?", "ag/claude-sonnet-4-6")).toEqual({ ok: false, error: "That model isn't available. Pick another one or Default." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("Default with no provider but Antigravity connected: the inbox (VM's own model)", async () => {
    h.loadAskContext.mockResolvedValue({ ...AG_ON, providerReady: false });
    expect((await askGeneral("Hi?", "")).ok).toBe(true);
    expect(h.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ model: null }));
  });
  it("passes the inbox's refusal on and doesn't audit a reused question", async () => {
    h.enqueue.mockResolvedValueOnce({ ok: false, error: "20 questions are already waiting for Antigravity. Let it answer some first." });
    expect(await askGeneral("q?", "ag/gemini-3.8-flash-high")).toEqual({ ok: false, error: "20 questions are already waiting for Antigravity. Let it answer some first." });
    h.enqueue.mockResolvedValueOnce({ ok: true, id: "g0", reused: true });
    expect(await askGeneral("q?", "ag/gemini-3.8-flash-high")).toEqual({ ok: true, message: ASSIST_COPY.alreadyWaiting, data: { id: "g0", status: "pending" } });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});



describe("questionStatus (the Playground polls one Antigravity question)", () => {
  const Q = "223e4567-e89b-42d3-a456-426614174000";
  const at = new Date("2026-10-13T11:05:30.000Z");
  it("returns status, answer, model and answeredAt of the member's own ask question", async () => {
    h.questionForOwner.mockResolvedValue({ id: Q, status: "answered", answer: "Two apps.", client: "antigravity", model: "gemini-3.8-flash", requestedModel: "gemini-3.8-flash", createdAt: at, answeredAt: at });
    expect(await questionStatus(Q)).toEqual({ ok: true, data: { status: "answered", answer: "Two apps.", model: "gemini-3.8-flash", answeredAt: at.toISOString() } });
    expect(h.questionForOwner).toHaveBeenCalledWith(Q, "user-1", expect.any(Date));
  });
  it("a waiting question has no answer yet; the requested model stands in", async () => {
    h.questionForOwner.mockResolvedValue({ id: Q, status: "pending", answer: null, client: null, model: null, requestedModel: "claude-sonnet-4-6", createdAt: at, answeredAt: null });
    expect(await questionStatus(Q)).toEqual({ ok: true, data: { status: "pending", answer: null, model: "claude-sonnet-4-6", answeredAt: null } });
  });
  it("refuses a malformed id before any read", async () => {
    expect(await questionStatus("nope")).toEqual(INVALID);
    expect(await questionStatus(42 as unknown as string)).toEqual(INVALID);
    expect(h.questionForOwner).not.toHaveBeenCalled();
  });
  it("a ping, someone else's question or a deleted one is not found", async () => {
    h.questionForOwner.mockResolvedValue(null);
    expect(await questionStatus(Q)).toEqual({ ok: false, error: "That question wasn't found. It may have been cleaned up." });
  });
  it("does not count toward the AI quota (polling every 3 s)", async () => {
    h.questionForOwner.mockResolvedValue(null);
    await questionStatus(Q);
    expect(h.limit).not.toHaveBeenCalled();
  });
});
