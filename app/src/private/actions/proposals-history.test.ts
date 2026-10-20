import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: async () => { throw new Error("use the injected book"); } }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: vi.fn(), recordResult: vi.fn(), discordTarget: vi.fn() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://never-used.example.test" }) }));
vi.mock("@/lib/notify/telegram", () => ({ sendTelegram: () => { throw new Error("tests never send a real message"); } }));
vi.mock("@/lib/notify/discord", () => ({ sendDiscord: () => { throw new Error("tests never send a real message"); } }));

import { historyLine, notifyAutoRollback, notifyHistory, notifyNewProposals, notifyProposalResult } from "./proposals-notify";
import { type DecideAndRunDeps, decideAndRun } from "./proposals-decide";
import { AUTO_RUN_OFF } from "./proposals-settings";
import { ACTIONS, type Proposal, type ProposalAction } from "./proposals-types";

const NOW = new Date("2026-10-19T03:05:00.000Z");
const BOOK = { db: [], app: [] };
const HOOK = "https://discord.com/api/web" + "hooks/123456789/abcdefghijklmnopqrstuvwxyz";

function proposal(over: Partial<Proposal> & { action?: ProposalAction } = {}): Proposal {
  const action = over.action ?? "daily_rerun";
  return {
    id: "p-1", room: "workloads", action, actionLabel: ACTIONS[action].label, risk: ACTIONS[action].risk,
    title: "Rerun the daily job", reason: "The daily job has not reported.", resourceName: null,
    proposedBy: "Workloads officer", status: "pending", auto: false, result: null,
    createdAt: NOW.toISOString(), decidedAt: null, expiresAt: NOW.toISOString(), ...over,
  };
}

let tg: string[];
let dc: string[];
function deps(over: Record<string, unknown> = {}) {
  return {
    target: vi.fn(async () => ({ token: "123456:test-token-not-real-0000000000", chatId: "-1" })),
    book: vi.fn(async () => BOOK),
    siteUrl: () => "https://watchpost.example.test",
    autoRun: vi.fn(async () => ({ ...AUTO_RUN_OFF })),
    send: vi.fn(async (_t: string, _c: string, html: string) => { tg.push(html); return { ok: true as const }; }),
    record: vi.fn(async () => undefined),
    lang: async () => "en" as const,
    buttons: async () => null,
    discord: vi.fn(async () => ({ url: HOOK })),
    sendDiscord: vi.fn(async (_u: string, text: string) => { dc.push(text); return { ok: true as const }; }),
    recordDiscord: vi.fn(async () => undefined),
    discordLang: async () => "en" as const,
    ...over,
  };
}
beforeEach(() => { tg = []; dc = []; });

describe("historyLine", () => {
  it("each event, English", () => {
    const p = proposal({ result: "Started." });
    expect(historyLine("proposed", p, BOOK, "en")).toBe("📝 Proposed: Rerun the daily job — waiting for approval on Telegram.");
    expect(historyLine("approved", p, BOOK, "en")).toBe("✅ Approved by the owner: Rerun the daily job");
    expect(historyLine("rejected", p, BOOK, "en")).toBe("🚫 Rejected by the owner: Rerun the daily job");
    expect(historyLine("done", p, BOOK, "en")).toBe("⚙️ Ran: Rerun the daily job — Started.");
    expect(historyLine("failed", p, BOOK, "en")).toBe("❌ Failed: Rerun the daily job — Started.");
    expect(historyLine("done", proposal(), BOOK, "en")).toBe("⚙️ Ran: Rerun the daily job");
  });
  it("each event, Indonesian", () => {
    const p = proposal({ result: "Jalan." });
    expect(historyLine("proposed", p, BOOK, "id")).toBe("📝 Usulan: Rerun the daily job — nunggu persetujuan di Telegram.");
    expect(historyLine("approved", p, BOOK, "id")).toBe("✅ Disetujui owner: Rerun the daily job");
    expect(historyLine("rejected", p, BOOK, "id")).toBe("🚫 Ditolak owner: Rerun the daily job");
    expect(historyLine("done", p, BOOK, "id")).toBe("⚙️ Dijalankan: Rerun the daily job — Jalan.");
    expect(historyLine("failed", p, BOOK, "id")).toBe("❌ Gagal: Rerun the daily job — Jalan.");
  });
  it("grouped lines count the proposals", () => {
    const list = [proposal(), proposal({ id: "p-2" }), proposal({ id: "p-3" }), proposal({ id: "p-4" })];
    expect(historyLine("proposed", list, BOOK, "en")).toBe("📝 4 new proposals — waiting for approval on Telegram.");
    expect(historyLine("proposed", list, BOOK, "id")).toBe("📝 4 usulan baru — nunggu persetujuan di Telegram.");
  });
  it("scrubs hosts, emails and Discord markdown; never a link or a button", () => {
    const p = proposal({ title: "Redeploy **my-site.vercel.app** for ana@example.com", result: "See https://app.secret-host.io/x [here](y) <@everyone>" });
    for (const ev of ["proposed", "approved", "rejected", "done", "failed"] as const) {
      const line = historyLine(ev, p, BOOK, "en");
      expect(line).not.toMatch(/vercel\.app|ana@|secret-host|https?:\/\/|\*\*|\[|\]|<|>/);
    }
    expect(historyLine("proposed", p, BOOK, "en")).not.toContain("auto-actions");
  });
});

describe("notifyNewProposals → Discord history", () => {
  it("sends a history line (no link, no buttons) in the Discord language, next to the Telegram notice", async () => {
    const d = deps({ discordLang: async () => "id" as const });
    await notifyNewProposals([proposal()], d, { now: NOW });
    expect(tg).toHaveLength(1);
    expect(dc).toEqual(["📝 Usulan: Rerun the daily job — nunggu persetujuan di Telegram."]);
    expect(d.sendDiscord).toHaveBeenCalledWith(HOOK, expect.any(String));
    expect(d.sendDiscord.mock.calls[0]).toHaveLength(2);
    expect(d.recordDiscord).toHaveBeenCalledWith({ ok: true }, NOW);
  });
  it("Discord off → nothing is sent there, Telegram unaffected", async () => {
    const d = deps({ discord: vi.fn(async () => null) });
    await notifyNewProposals([proposal()], d, { now: NOW });
    expect(dc).toEqual([]);
    expect(d.sendDiscord).not.toHaveBeenCalled();
    expect(tg).toHaveLength(1);
  });
  it("Telegram not connected → Discord still gets its history", async () => {
    await notifyNewProposals([proposal()], deps({ target: vi.fn(async () => null) }), { now: NOW });
    expect(tg).toEqual([]);
    expect(dc).toHaveLength(1);
  });
  it("Discord throwing → Telegram still sent, the function resolves", async () => {
    const d = deps({ sendDiscord: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(notifyNewProposals([proposal()], d, { now: NOW })).resolves.toBeUndefined();
    expect(tg).toHaveLength(1);
    expect(d.recordDiscord).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), NOW);
    const e = deps({ discord: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(notifyNewProposals([proposal()], e, { now: NOW })).resolves.toBeUndefined();
    expect(tg).toHaveLength(2);
  });
  it("a recording failure is swallowed", async () => {
    const d = deps({ recordDiscord: vi.fn(async () => { throw new Error("x"); }) });
    await expect(notifyNewProposals([proposal()], d, { now: NOW })).resolves.toBeUndefined();
  });
  it("up to 3 proposals → one Discord message, one line each; more → one grouped line", async () => {
    await notifyNewProposals([proposal(), proposal({ id: "p-2", title: "Redeploy production" })], deps(), { now: NOW });
    expect(dc).toHaveLength(1);
    expect(dc[0].split("\n")).toHaveLength(2);
    dc = [];
    await notifyNewProposals([1, 2, 3, 4].map((n) => proposal({ id: `p-${n}` })), deps(), { now: NOW });
    expect(dc).toEqual(["📝 4 new proposals — waiting for approval on Telegram."]);
  });
  it("proposals that don't need the owner produce no history line", async () => {
    await notifyNewProposals([proposal({ action: "recheck", risk: "safe", auto: true })], deps(), { now: NOW });
    expect(dc).toEqual([]);
  });
});

describe("auto results → Discord history", () => {
  it("an auto-run result and an auto-rollback result each produce a ran / failed line", async () => {
    await notifyProposalResult(proposal({ action: "recheck", auto: true, status: "done", result: "Checked." }), deps(), { now: NOW });
    expect(dc).toEqual(["⚙️ Ran: Rerun the daily job — Checked."]);
    dc = [];
    await notifyAutoRollback(proposal({ status: "failed", result: "No previous deploy." }), { reason: "errors", newRef: "abc" }, deps(), { now: NOW });
    expect(dc).toEqual(["❌ Failed: Rerun the daily job — No previous deploy."]);
  });
  it("a non-auto result sends nothing from notifyProposalResult", async () => {
    await notifyProposalResult(proposal({ status: "done" }), deps(), { now: NOW });
    expect(dc).toEqual([]);
  });
});

describe("notifyHistory", () => {
  it("one event, one line", async () => {
    await notifyHistory("approved", proposal(), deps(), { now: NOW });
    expect(dc).toEqual(["✅ Approved by the owner: Rerun the daily job"]);
  });
});

describe("decideAndRun → history (Telegram buttons and the console share this path)", () => {
  const M = { id: "mem-1", userId: "user-1" };
  function run(ranStatus: Proposal["status"] | null, history?: DecideAndRunDeps["history"]) {
    const events: string[] = [];
    const d: DecideAndRunDeps = {
      decide: vi.fn(async (_id, decision) => ({ status: "ok" as const, proposal: proposal({ status: decision === "approve" ? "approved" : "rejected" }) })),
      execute: vi.fn(async () => (ranStatus ? proposal({ status: ranStatus, result: "Done it." }) : null)),
      history: history ?? vi.fn(async (event) => { events.push(event); }),
    };
    return { d, events };
  }
  it("approve → approved, then done / failed, sent only when flushed", async () => {
    for (const s of ["done", "failed"] as const) {
      const { d, events } = run(s);
      const r = await decideAndRun("p-1", "approve", M, NOW, {}, d);
      expect(events).toEqual([]);
      await r.flushHistory?.();
      expect(events).toEqual(["approved", s]);
    }
  });
  it("reject → rejected only, after the flush", async () => {
    const { d, events } = run("done");
    const r = await decideAndRun("p-1", "reject", M, NOW, {}, d);
    expect(events).toEqual([]);
    await r.flushHistory?.();
    expect(events).toEqual(["rejected"]);
  });
  it("conflict / missing → nothing to flush; a run claimed elsewhere → approved only", async () => {
    const history = vi.fn(async () => undefined);
    for (const outcome of [{ status: "missing" }, { status: "conflict", proposal: proposal() }] as const) {
      const r = await decideAndRun("p-1", "approve", M, NOW, {}, { decide: vi.fn(async () => outcome), execute: vi.fn(), history } as unknown as DecideAndRunDeps);
      expect(r.flushHistory).toBeUndefined();
    }
    expect(history).not.toHaveBeenCalled();
    const { d, events } = run(null);
    const r = await decideAndRun("p-1", "approve", M, NOW, {}, d);
    await r.flushHistory?.();
    expect(events).toEqual(["approved"]);
  });
  it("a throwing history never breaks the decision or the flush", async () => {
    const { d } = run("done", vi.fn(async () => { throw new Error("x"); }));
    const r = await decideAndRun("p-1", "approve", M, NOW, {}, d);
    expect(r).toMatchObject({ status: "ok" });
    await expect(r.flushHistory?.()).resolves.toBeUndefined();
  });
  it("a hung history never delays decideAndRun's result; the flush gives up after about 3 s", async () => {
    vi.useFakeTimers();
    try {
      const { d } = run("done", vi.fn(() => new Promise<void>(() => undefined)));
      const r = await decideAndRun("p-1", "approve", M, NOW, {}, d); // resolves with no timer advance
      expect(r.status).toBe("ok");
      let done = false;
      const flush = r.flushHistory!().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(2_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await flush;
      expect(done).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
