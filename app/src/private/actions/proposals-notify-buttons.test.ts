import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: async () => { throw new Error("use the injected book"); } }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: vi.fn(), recordResult: vi.fn(), discordTarget: vi.fn(async () => null) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://never-used.example.test" }) }));
vi.mock("@/lib/notify/telegram", () => ({ sendTelegram: () => { throw new Error("tests never send a real message"); } }));

import type { InlineKeyboard } from "@/lib/notify/telegram-bot";
import { notifyNewProposals } from "./proposals-notify";
import { AUTO_RUN_OFF } from "./proposals-settings";
import { ACTIONS, type Proposal } from "./proposals-types";

// Stage 9 slice 7: the approval buttons on a proposal's Telegram notice.
const NOW = new Date("2026-10-16T03:00:00.000Z");
const SITE = "https://watchpost.example.test";
const proposal = (id: string): Proposal => ({
  id, room: "workloads", action: "vercel_redeploy", actionLabel: ACTIONS.vercel_redeploy.label, risk: "risky", title: "Redeploy", reason: "r", resourceName: null,
  proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: NOW.toISOString(), decidedAt: null, expiresAt: NOW.toISOString(),
});
const kb = (id: string): InlineKeyboard => ({ inline_keyboard: [[{ text: "✅ Approve", callback_data: `p:${id}:a:x` }, { text: "❌ Reject", callback_data: `p:${id}:r:x` }]] });

function deps(buttons: (() => Promise<((p: Proposal) => InlineKeyboard) | null>) | undefined) {
  const calls: { html: string; keyboard?: InlineKeyboard }[] = [];
  return {
    calls,
    d: {
      target: async () => ({ token: "123456:test-token-not-real-0000000000", chatId: "-1" }),
      book: async () => ({ db: [], app: [] }),
      siteUrl: () => SITE,
      autoRun: async () => ({ ...AUTO_RUN_OFF }),
      send: vi.fn(async (_t: string, _c: string, html: string, keyboard?: InlineKeyboard) => { calls.push({ html, keyboard }); return { ok: true as const }; }),
      record: async () => undefined,
      lang: async () => "en" as const,
      buttons,
    },
  };
}

describe("proposal notices with approval buttons", () => {
  it("buttons on: each notice gets [✅ Approve, ❌ Reject], the status line and still the Auto-actions link", async () => {
    const { d, calls } = deps(async () => (p) => kb(p.id));
    await notifyNewProposals([proposal("a"), proposal("b")], d, { now: NOW });
    expect(calls.map((c) => c.keyboard)).toEqual([kb("a"), kb("b")]);
    expect(calls[0].html).toContain(`Open in Auto-actions: ${SITE}/auto-actions?proposal=a`);
    expect(calls[0].html.split("\n").pop()).toBe("Status: ⏳ waiting");
  });
  it("buttons off (or can't tell): the link-only notice, unchanged", async () => {
    for (const b of [async () => null, async () => { throw new Error("db down"); }]) {
      const { d, calls } = deps(b);
      await notifyNewProposals([proposal("a")], d, { now: NOW });
      expect(calls[0].keyboard).toBeUndefined();
      expect(calls[0].html).not.toContain("Status:");
    }
  });
  it("a grouped message (more than 3) has no buttons and doesn't ask for them", async () => {
    const buttons = vi.fn(async () => (p: Proposal) => kb(p.id));
    const { d, calls } = deps(buttons);
    await notifyNewProposals(["a", "b", "c", "d"].map(proposal), d, { now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0].keyboard).toBeUndefined();
    expect(buttons).not.toHaveBeenCalled();
  });
});
