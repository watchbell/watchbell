import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: async () => { throw new Error("use the injected book"); } }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: vi.fn(), recordResult: vi.fn(), discordTarget: vi.fn(async () => null) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://never-used.example.test" }) }));
vi.mock("@/lib/notify/telegram", () => ({ sendTelegram: () => { throw new Error("tests never send a real message"); } }));

import { actionsUrl, autoRollbackMessage, depPrMessage, notifyNewProposals, notifyProposalResult, proposalMessage, proposalResultMessage, proposalsGroupMessage } from "./proposals-notify";
import { AUTO_RUN_OFF } from "./proposals-settings";
import { ACTIONS, type Proposal, type ProposalAction } from "./proposals-types";

const NOW = new Date("2026-10-15T03:05:00.000Z");
const TARGET = { token: "123456:test-token-not-real-0000000000", chatId: "-100200300" };
const SITE = "https://watchpost.example.test/";
const BOOK = { db: [], app: [] };

function proposal(over: Partial<Proposal> & { action?: ProposalAction } = {}): Proposal {
  const action = over.action ?? "vercel_redeploy";
  return {
    id: "p-1", room: "workloads", action, actionLabel: ACTIONS[action].label, risk: ACTIONS[action].risk,
    title: "Redeploy production", reason: "Error rate di atas 5% selama 10 menit.", resourceName: null,
    proposedBy: "Workloads officer", status: "pending", auto: false, result: null,
    createdAt: NOW.toISOString(), decidedAt: null, expiresAt: NOW.toISOString(), ...over,
  };
}

let sent: string[];
function deps(over: Record<string, unknown> = {}) {
  return {
    target: vi.fn(async () => TARGET),
    book: vi.fn(async () => BOOK),
    siteUrl: () => SITE,
    autoRun: vi.fn(async () => ({ ...AUTO_RUN_OFF })),
    send: vi.fn(async (_t: string, _c: string, html: string) => { sent.push(html); return { ok: true as const }; }),
    record: vi.fn(async () => undefined),
    lang: async () => "en" as const,
    // No approval buttons here (proposals-notify-buttons.test.ts covers them); the default loads telegram-approvals,
    // which is slow to import cold under the full suite and made these tests time out.
    buttons: async () => null,
    ...over,
  };
}

beforeEach(() => { sent = []; });

describe("actionsUrl", () => {
  it("points at /auto-actions, trims trailing slashes and encodes the id", () => {
    expect(actionsUrl("https://watchpost.example.test//")).toBe("https://watchpost.example.test/auto-actions");
    expect(actionsUrl("https://watchpost.example.test", "p-1")).toBe("https://watchpost.example.test/auto-actions?proposal=p-1");
    expect(actionsUrl("https://watchpost.example.test/", "p 1")).toBe("https://watchpost.example.test/auto-actions?proposal=p%201");
  });
});

describe("proposalMessage", () => {
  it("the agreed Indonesian lines, HTML-escaped, with the link to the proposal in Auto-actions", () => {
    const text = proposalMessage(proposal({ id: "p 1", title: "Redeploy <b>prod</b> & co" }), BOOK, SITE);
    expect(text).toBe([
      "🧑‍✈️ Workloads officer proposes: Redeploy production — Redeploy &lt;b&gt;prod&lt;/b&gt; &amp; co",
      "Why: Error rate di atas 5% selama 10 menit.",
      "Risk: needs care",
      "Open in Auto-actions: https://watchpost.example.test/auto-actions?proposal=p%201",
    ].join("\n"));
    expect(proposalMessage(proposal({ action: "recheck" }), BOOK, SITE)).toContain("Risk: safe");
  });

  it("adds the Dev line when the Dev officer was asked to read the code (slice 3)", () => {
    const lines = proposalMessage(proposal({}), BOOK, SITE, true).split("\n");
    expect(lines[3]).toBe("🧑‍💻 Dev is checking the code");
    expect(lines).toHaveLength(5);
    expect(proposalMessage(proposal({}), BOOK, SITE)).not.toContain("Dev is checking");
  });

  it("never carries an email or a hostname", () => {
    const text = proposalMessage(proposal({ title: "Cek owner@example.com", reason: "db.internal-host.co.id lambat, kabari someone@corp.test" }), BOOK, SITE);
    expect(text).not.toMatch(/owner@example\.com|someone@corp\.test|internal-host/);
  });
});

describe("autoRollbackMessage", () => {
  const p = (o: Partial<Proposal>) => proposal({ action: "vercel_rollback", auto: true, resourceName: "app-a", ...o });
  it("says what went back and why, what to do next, then the result", () => {
    const text = autoRollbackMessage(p({ status: "done", result: "Rolled back app-a to 1234abc." }), { reason: "Monitor app-a / down: 3 consecutive checks failed.", newRef: "abcdef1" }, BOOK);
    expect(text).toBe([
      "⏪ Automatic rollback of app-a: Monitor app-a / down: 3 consecutive checks failed. The new deploy abcdef1 was rolled back to the previous one. Fix it first, then deploy again.",
      "✅ Succeeded: Rolled back app-a to 1234abc.",
    ].join("\n"));
  });
  it("a failed run says so, and nothing leaks", () => {
    const text = autoRollbackMessage(p({ status: "failed", result: "Hobby can only roll back to the previous production deployment." }), { reason: "Error at owner@example.com <b>", newRef: "dpl_x" }, BOOK);
    expect(text.split("\n")[1]).toBe("❌ Failed: Hobby can only roll back to the previous production deployment.");
    expect(text).not.toMatch(/owner@example\.com|<b>/);
  });
});

describe("notifyNewProposals", () => {
  it("risky and safe-but-not-auto-run pending proposals: one message each to the connected chat, result recorded", async () => {
    const d = deps();
    await notifyNewProposals([proposal({ id: "a" }), proposal({ id: "b", action: "recheck" })], d, { now: NOW });
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.send.mock.calls[0].slice(0, 2)).toEqual([TARGET.token, TARGET.chatId]);
    expect(sent[0]).toContain("?proposal=a");
    expect(sent[1]).toContain("?proposal=b");
    expect(d.record).toHaveBeenCalledWith({ ok: true }, NOW);
  });

  it("skips auto-run kinds, proposals already running / decided, and auto ones", async () => {
    const d = deps({ autoRun: async () => ({ ...AUTO_RUN_OFF, recheck: true, vercel_redeploy: true }) });
    await notifyNewProposals([
      proposal({ id: "auto-kind", action: "recheck" }),
      proposal({ id: "ran", action: "neon_wake", auto: true, status: "running" }),
      proposal({ id: "rejected", status: "rejected" }),
      proposal({ id: "risky" }), // vercel_redeploy "on" in a hand-edited setting still asks
    ], d, { now: NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("?proposal=risky");
  });

  it("can't read the auto-run setting: asks for every proposal rather than skipping one", async () => {
    const d = deps({ autoRun: async () => { throw new Error("db down"); } });
    await notifyNewProposals([proposal({ id: "s", action: "recheck" })], d, { now: NOW });
    expect(sent).toHaveLength(1);
  });

  it("more than 3: one grouped message listing each with its link", async () => {
    const d = deps();
    const list = ["a", "b", "c", "d"].map((id) => proposal({ id, title: `Proposal ${id}` }));
    await notifyNewProposals(list, d, { now: NOW });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatch(/^🧑‍✈️ 4 new proposals waiting for approval:/);
    for (const id of ["a", "b", "c", "d"]) expect(sent[0]).toContain(`/auto-actions?proposal=${id}`);
    expect(sent[0]).toContain("Open in Auto-actions: https://watchpost.example.test/auto-actions");

    sent = [];
    await notifyNewProposals(Array.from({ length: 14 }, (_, i) => proposal({ id: `x${i}`, reason: "x".repeat(500), title: "y".repeat(500) })), deps(), { now: NOW });
    expect(sent[0]).toContain("+4 more proposals");
    expect(sent[0].length).toBeLessThanOrEqual(4096);
  });

  it("Telegram not connected: nothing sent, nothing recorded", async () => {
    const d = deps({ target: async () => null });
    await notifyNewProposals([proposal()], d, { now: NOW });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it("never throws: a refused or throwing send is recorded, a hang gives up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused = { ok: false as const, kind: "config" as const, error: "Telegram: chat not found" };
    const d = deps({ send: vi.fn(async () => refused) });
    await expect(notifyNewProposals([proposal()], d, { now: NOW })).resolves.toBeUndefined();
    expect(d.record).toHaveBeenCalledWith(refused, NOW);

    const d2 = deps({ send: vi.fn(async () => { throw new Error("socket"); }) });
    await notifyNewProposals([proposal()], d2, { now: NOW });
    expect(d2.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "Telegram didn't answer." }), NOW);

    await expect(notifyNewProposals([proposal()], deps({ target: async () => { throw new Error("db down"); } }))).resolves.toBeUndefined();
    await expect(notifyNewProposals([proposal()], deps({ send: () => new Promise(() => undefined) }), { timeoutMs: 20 })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("notifyProposalResult", () => {
  it("an auto-run proposal that finished: one line, ✅ done or ❌ failed", async () => {
    const d = deps();
    await notifyProposalResult(proposal({ action: "recheck", title: "Cek ulang api", auto: true, status: "done", result: "Sehat lagi (200 OK)." }), d, { now: NOW });
    await notifyProposalResult(proposal({ action: "neon_wake", title: "Neon db-a", auto: true, status: "failed", result: "Neon <menolak>." }), d, { now: NOW });
    expect(sent).toEqual(["✅ Automatic: Check again now — Cek ulang api: Sehat lagi (200 OK).", "❌ Automatic: Wake Neon — Neon db-a: Neon &lt;menolak&gt;."]);
  });

  it("not auto, or not finished: nothing", async () => {
    const d = deps();
    await notifyProposalResult(proposal({ status: "done", result: "ok" }), d);
    await notifyProposalResult(proposal({ action: "recheck", auto: true, status: "running" }), d);
    expect(d.target).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe("depPrMessage (automatic security fixes)", () => {
  it("merged, stopped and ready-for-manual, short and in English", () => {
    expect(depPrMessage({ kind: "merged", app: "app-a", number: 12, packages: ["next", "lodash"], windowMin: 30 }, BOOK))
      .toBe("✅ PR #12 in app-a was merged automatically (next, lodash). The production deploy runs through Vercel; auto-rollback watches the first 30 minutes.");
    expect(depPrMessage({ kind: "stopped", app: "app-a", number: 12, packages: ["next"], reason: "CI failed" }, BOOK))
      .toBe("⚠️ PR #12 in app-a needs a look: CI failed. The PR was left open.");
    expect(depPrMessage({ kind: "ready-manual", app: "app-a", number: 12, packages: ["next"] }, BOOK))
      .toBe("🔐 PR #12 in app-a is ready to merge, but auto-rollback is off — please merge it manually.");
  });
  it("escapes and scrubs", () => {
    const t = depPrMessage({ kind: "stopped", app: "<b>x</b>", number: 1, packages: ["a"], reason: "owner@example.com broke it" }, BOOK);
    expect(t).not.toMatch(/<b>|owner@example\.com/);
  });
});

describe("Indonesian notices (lang: id)", () => {
  it("one proposal: Indonesian labels, risk and link; the reason stays as stored", () => {
    const text = proposalMessage(proposal({ id: "p-1", action: "vercel_rollback", proposedBy: "" }), BOOK, SITE, true, "id");
    expect(text).toBe([
      `🧑‍✈️ ${ACTIONS_COPY.notifyFallback.id} usul: Rollback ke deploy sebelumnya — Redeploy production`,
      "Kenapa: Error rate di atas 5% selama 10 menit.",
      "Risiko: perlu hati-hati",
      "🧑‍💻 Dev lagi cek kodenya",
      "Buka di Auto-actions: https://watchpost.example.test/auto-actions?proposal=p-1",
    ].join("\n"));
    expect(proposalMessage(proposal({ action: "recheck", risk: "safe" }), BOOK, SITE, false, "id")).toContain("Risiko: aman");
  });
  it("every action has its Indonesian name", () => {
    const names = (Object.keys(ACTIONS) as ProposalAction[]).map((a) => proposalMessage(proposal({ action: a }), BOOK, SITE, false, "id").split("\n")[0].split(": ")[1].split(" — ")[0]);
    expect(names).toEqual([
      "Cek ulang sekarang", "Bangunin Neon", "Kirim keep-alive Supabase", "Restore project Supabase",
      "Redeploy production", "Rollback ke deploy sebelumnya", "Bikin PR update paket", "Cek ulang sertifikat domain", "Jalanin ulang daily job",
      "Arahin monitor ke domain baru",
    ]);
  });
  it("grouped, result, rollback and dep-PR lines", async () => {
    const list = Array.from({ length: 14 }, (_, i) => proposal({ id: `x${i}` }));
    const g = proposalsGroupMessage(list, BOOK, SITE, new Set(), "id");
    expect(g).toMatch(/^🧑‍✈️ 14 usulan baru menunggu persetujuan:/);
    expect(g).toContain("+4 usulan lagi");
    expect(g).toContain("Buka di Auto-actions: https://watchpost.example.test/auto-actions");
    expect(proposalResultMessage(proposal({ auto: true, status: "done", result: "OK" }), BOOK, "id")).toBe("✅ Otomatis: Redeploy production — Redeploy production: OK");
    const rb = autoRollbackMessage(proposal({ action: "vercel_rollback", resourceName: "app-a", status: "failed", result: "Nope" }), { reason: "", newRef: "abc" }, BOOK, "id");
    expect(rb).toBe("⏪ Otomatis rollback app-a: app-nya error setelah deploy baru. Deploy baru abc dibalikin ke deploy sebelumnya. Benerin dulu, terus deploy ulang.\n❌ Gagal: Nope");
    expect(depPrMessage({ kind: "merged", app: "app-a", number: 7, packages: ["a"], windowMin: 20 }, BOOK, "id")).toBe("✅ PR #7 di app-a di-merge otomatis (a). Deploy production jalan lewat Vercel; auto-rollback jaga 20 menit pertama.");
    expect(depPrMessage({ kind: "ready-manual", app: "app-a", number: 7, packages: [] }, BOOK, "id")).toBe("🔐 PR #7 di app-a siap di-merge, tapi auto-rollback mati — merge manual ya.");
    expect(depPrMessage({ kind: "stopped", app: "app-a", number: 7, packages: [] }, BOOK, "id")).toBe("⚠️ PR #7 di app-a butuh dicek: ada yang gagal. PR-nya dibiarin terbuka.");
  });
  it("the sender uses the language from its deps", async () => {
    const d = deps({ lang: async () => "id" as const });
    await notifyNewProposals([proposal()], d, { now: NOW });
    expect(sent[0]).toContain("Buka di Auto-actions");
    const e = deps({ lang: async () => { throw new Error("db"); } });
    sent = [];
    await notifyNewProposals([proposal()], e, { now: NOW });
    expect(sent[0]).toContain("Open in Auto-actions");
  });
});
