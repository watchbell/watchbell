import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_COPY, WHY_COPY } from "@/lib/copy/edition";
import type { NoteView } from "@/private/notes/notes-view";

const m = vi.hoisted(() => ({
  pageGate: vi.fn(), provider: vi.fn(), latestFor: vi.fn(), readSummary: vi.fn(), listNotes: vi.fn(), loadAskContext: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ pageGate: m.pageGate, requireActionMember: vi.fn() }));
vi.mock("@/private/assist/ports", () => ({ ports: { provider: m.provider } }));
vi.mock("@/private/assist/questions-db", () => ({ latestFor: m.latestFor }));
vi.mock("@/private/assist/provider-answer", () => ({ loadAskContext: m.loadAskContext }));
vi.mock("@/private/assist/summary", () => ({ readSummary: m.readSummary }));
vi.mock("@/private/notes/notes-view", () => ({ listNotes: m.listNotes }));
vi.mock("@/private/assist/actions", () => ({ askWhy: vi.fn(), askAntigravity: vi.fn(), regenerateSummary: vi.fn() }));
vi.mock("@/private/notes/notes-actions", () => ({ dismissNote: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { registry } from "@/private/registry";
import { AiNotesSlot } from "./ai-notes-slot";
import { NoteCard } from "./note-card";
import { RecSummarySlot } from "./rec-summary-slot";
import { WhyAi } from "./why-ai";
import { WhyAiSlot } from "./why-ai-slot";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-10-13T03:00:00.000Z");
const render = async (el: Promise<React.ReactNode> | React.ReactNode) => renderToStaticMarkup(h("div", null, await el));
const note = (o: Partial<NoteView> = {}): NoteView => ({
  id: "n1", appId: APP, appName: "orbit-blog", severity: "crit", title: "orbit-blog: down after a failed deploy",
  body: "Roll back **first**.\n\n- check the build log", from: "antigravity/1.4", model: "gemini-3.8-flash", at: new Date(NOW.getTime() - 3 * 3600_000), ...o,
});
const q = (o: object = {}) => ({ id: "q1", status: "pending" as const, answer: null, client: null, model: null, createdAt: new Date(NOW.getTime() - 120_000).toISOString(), answeredAt: null, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  m.pageGate.mockResolvedValue({ ok: true, member: { role: "owner" } });
  m.provider.mockResolvedValue({ name: "Gemini", model: "gemini/gemini-3.8-flash" });
  m.latestFor.mockResolvedValue(null);
  m.readSummary.mockResolvedValue(null);
  m.listNotes.mockResolvedValue([]);
  m.loadAskContext.mockResolvedValue({ agConnected: true, agEnabled: [], providerReady: true });
});

describe("registry (T6 block)", () => {
  it("registers the three slots and the advisor-summary daily step", () => {
    expect(registry.WhyAiSlot).toBe(WhyAiSlot);
    expect(registry.RecSummarySlot).toBe(RecSummarySlot);
    expect(registry.AiNotesSlot).toBe(AiNotesSlot);
    expect(registry.dailySteps?.map((s) => s.name)).toContain("advisor-summary");
    // T6's advisor notes (07:00 / 19:00 WIB) from the minute run. The full step order is pinned in registry.test.ts.
    expect(registry.minuteSteps?.map((s) => s.name)).toContain("advisor-notes");
  });
  it("has exactly one retention step for the AI inbox tables (T7's ai-notes-retention)", () => {
    const names = registry.dailySteps?.map((s) => s.name) ?? [];
    expect(names.filter((n) => n === "ai-notes-retention")).toHaveLength(1);
    expect(names).not.toContain("ai-inbox-retention");
  });
});

describe("WhyAi (client block under the problems)", () => {
  it("always offers Ask Antigravity; Answer now only with a provider", () => {
    const without = renderToStaticMarkup(h(WhyAi, { agConnected: true, appId: APP, provider: null, question: null, nowMs: NOW.getTime() }));
    expect(without).toContain(WHY_COPY.ask);
    expect(without).not.toContain("Answer now");
    const withP = renderToStaticMarkup(h(WhyAi, { agConnected: true, appId: APP, provider: { model: "gemini/gemini-3.8-flash" }, question: null, nowMs: NOW.getTime() }));
    expect(withP).toContain("Answer now with gemini/gemini-3.8-flash");
    expect(withP).toContain(WHY_COPY.ask);
    expect(withP).toContain("names aliased");
  });
  it("a pending question shows Waiting for Antigravity… and blocks asking again", () => {
    const out = renderToStaticMarkup(h(WhyAi, { agConnected: true, appId: APP, provider: null, question: q(), nowMs: NOW.getTime() }));
    expect(out).toContain(ASK_COPY.waiting);
    expect(out).toMatch(new RegExp(`<button[^>]*disabled[^>]*>[^]*${WHY_COPY.ask}`));
  });
  it("an answered question shows the answer as safe markdown with client and model", () => {
    const out = renderToStaticMarkup(h(WhyAi, {
      agConnected: true, appId: APP, provider: null, nowMs: NOW.getTime(),
      question: q({ status: "answered", answer: "Roll back <script>x</script> [l](https://e.example.com)", client: "antigravity/1.4", model: "gemini-3.8-flash", answeredAt: NOW.toISOString() }),
    }));
    expect(out).toContain("antigravity/1.4 · gemini-3.8-flash");
    expect(out).toContain("Roll back");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<a ");
    expect(out).toContain(WHY_COPY.askAgain);
    expect(out).not.toContain(ASK_COPY.waiting);
  });
  it("an expired question says nobody answered and allows asking again", () => {
    const out = renderToStaticMarkup(h(WhyAi, { agConnected: true, appId: APP, provider: null, question: q({ status: "expired" }), nowMs: NOW.getTime() }));
    expect(out).toContain("no answer within 7 days");
    expect(out).toContain(WHY_COPY.askAgain);
  });
});

describe("WhyAi while Antigravity is not connected (owner 14 Oct)", () => {
  it("one Ask <model> button that the provider answers; no Ask Antigravity, no separate Answer now", () => {
    const out = renderToStaticMarkup(h(WhyAi, { appId: APP, provider: { model: "test/prrojects" }, question: null, nowMs: NOW.getTime(), agConnected: false }));
    expect(out).toContain("Ask test/prrojects");
    expect(out).not.toContain(WHY_COPY.ask);
    expect(out).not.toContain("Answer now");
    expect(out).toContain("kept for 7 days on AI › Ask");
  });
  it("no provider either: says how to connect one, no buttons", () => {
    const out = renderToStaticMarkup(h(WhyAi, { appId: APP, provider: null, question: null, nowMs: NOW.getTime(), agConnected: false }));
    expect(out).toContain("No AI provider is connected");
    expect(out).not.toContain("<button");
  });
  it("a stored provider answer is headed The answer", () => {
    const out = renderToStaticMarkup(h(WhyAi, {
      appId: APP, provider: { model: "test/prrojects" }, nowMs: NOW.getTime(), agConnected: false,
      question: q({ status: "answered", answer: "Roll back.", client: "watchpost", model: "test/prrojects", answeredAt: NOW.toISOString() }),
    }));
    expect(out).toContain("The answer");
    expect(out).toContain("watchpost · test/prrojects");
  });
});

describe("WhyAiSlot", () => {
  it("renders nothing for a non-owner, and reads nothing", async () => {
    m.pageGate.mockResolvedValue({ ok: false, member: { role: "operator" } });
    expect(await WhyAiSlot({ appId: APP })).toBeNull();
    expect(m.provider).not.toHaveBeenCalled();
    expect(m.latestFor).not.toHaveBeenCalled();
  });
  it("passes the provider and the app's latest question to the block", async () => {
    m.latestFor.mockResolvedValue({ id: "q1", status: "pending", answer: null, client: null, model: null, createdAt: new Date(NOW.getTime() - 60_000), answeredAt: null });
    const out = await render(WhyAiSlot({ appId: APP }));
    expect(m.latestFor).toHaveBeenCalledWith("app", APP, expect.any(Date));
    expect(out).toContain("Answer now with gemini/gemini-3.8-flash");
    expect(out).toContain(ASK_COPY.waiting);
  });
  it("still renders when the reads fail (not connected, no provider: how to connect one)", async () => {
    m.provider.mockRejectedValue(new Error("x"));
    m.latestFor.mockRejectedValue(new Error("y"));
    m.loadAskContext.mockRejectedValue(new Error("z"));
    const out = await render(WhyAiSlot({ appId: APP }));
    expect(out).toContain("No AI provider is connected");
    expect(out).not.toContain("Answer now");
  });
  it("Antigravity not connected: the provider's Ask button", async () => {
    m.loadAskContext.mockResolvedValue({ agConnected: false, agEnabled: [], providerReady: true });
    const out = await render(WhyAiSlot({ appId: APP }));
    expect(out).toContain("Ask gemini/gemini-3.8-flash");
    expect(out).not.toContain(WHY_COPY.ask);
  });
});

describe("RecSummarySlot", () => {
  const summary = { text: "Two items need action this week.", model: "gemini/gemini-3.8-flash", at: "2026-10-13T01:00:00.000Z", count: 4, hash: "a".repeat(64) };
  it("renders nothing for a non-owner", async () => {
    m.pageGate.mockResolvedValue({ ok: false, member: { role: "viewer" } });
    expect(await RecSummarySlot({ count: 4 })).toBeNull();
  });
  it("without a provider: only a short link to /ai/connect, no summary even if one is stored", async () => {
    m.provider.mockResolvedValue(null);
    m.readSummary.mockResolvedValue(summary);
    const out = await render(RecSummarySlot({ count: 4 }));
    expect(out).toContain(WHY_COPY.recConnect);
    expect(out).toContain('href="/ai/connect"');
    expect(out).not.toContain("Two items need action");
    expect(m.readSummary).not.toHaveBeenCalled();
  });
  it("without a provider but with agent notes: nothing (an agent is already connected)", async () => {
    m.provider.mockResolvedValue(null);
    m.listNotes.mockResolvedValue([note()]);
    expect(await RecSummarySlot({ count: 4 })).toBeNull();
  });
  it("with a provider and a stored summary: the summary, model, count, can-be-wrong and Regenerate", async () => {
    m.readSummary.mockResolvedValue(summary);
    const out = await render(RecSummarySlot({ count: 4 }));
    expect(out).toContain("Two items need action this week.");
    expect(out).toContain("gemini/gemini-3.8-flash");
    expect(out).toContain("from 4 items, names aliased");
    expect(out).toContain("can be wrong");
    expect(out).toContain("Regenerate");
  });
  it("with a provider and no stored summary: a Summarise button, nothing more", async () => {
    const out = await render(RecSummarySlot({ count: 4 }));
    expect(out).toContain("No AI summary yet");
    expect(out).toContain("Summarise");
  });
  it("with a provider and no recommendations: nothing", async () => {
    expect(await RecSummarySlot({ count: 0 })).toBeNull();
  });
});

describe("AiNotesSlot / NoteCard", () => {
  it("renders nothing for a non-owner and when there are no notes", async () => {
    m.pageGate.mockResolvedValue({ ok: false, member: { role: "viewer" } });
    expect(await AiNotesSlot({})).toBeNull();
    expect(m.listNotes).not.toHaveBeenCalled();
    m.pageGate.mockResolvedValue({ ok: true, member: { role: "owner" } });
    expect(await AiNotesSlot({})).toBeNull();
  });
  it("asks for one app's notes on the app page", async () => {
    m.listNotes.mockResolvedValue([note()]);
    await AiNotesSlot({ appId: APP });
    expect(m.listNotes).toHaveBeenCalledWith(APP, expect.any(Date));
  });
  it("Overview names the app; the app page doesn't repeat it", async () => {
    m.listNotes.mockResolvedValue([note()]);
    const all = await render(AiNotesSlot({}));
    expect(all).toContain("AI note · from antigravity/1.4 · gemini-3.8-flash");
    expect(all).toContain("orbit-blog</span>".slice(0, 10));
    expect(all).toMatch(/ · orbit-blog · written by an agent, can be wrong/);
    const one = await render(AiNotesSlot({ appId: APP }));
    expect(one).not.toMatch(/ · orbit-blog · written by an agent/);
  });
  it("shows title, markdown body, a Dismiss button and a severity rule", () => {
    const out = renderToStaticMarkup(h(NoteCard, { note: note(), now: NOW, showApp: true }));
    expect(out).toContain("orbit-blog: down after a failed deploy");
    expect(out).toContain("<b ");
    expect(out).toContain("<li>check the build log</li>");
    expect(out).toContain("Dismiss");
    expect(out).toContain("border-l-err");
    expect(renderToStaticMarkup(h(NoteCard, { note: note({ severity: "warn" }), now: NOW, showApp: false }))).toContain("border-l-warn-icon");
    expect(renderToStaticMarkup(h(NoteCard, { note: note({ severity: "info" }), now: NOW, showApp: false }))).toContain("border-l-brand");
  });
  it("renders agent-written html as text, never as markup", () => {
    const out = renderToStaticMarkup(h(NoteCard, { note: note({ title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script> [x](https://e.example.com)" }), now: NOW, showApp: false }));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<a ");
  });
});
