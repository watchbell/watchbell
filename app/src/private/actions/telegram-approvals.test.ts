import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: async () => { throw new Error("use the injected book"); } }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: vi.fn(), recordResult: vi.fn(), discordTarget: vi.fn(async () => null) }));
vi.mock("@/lib/notify/telegram", () => ({ sendTelegram: () => { throw new Error("tests never send a real message"); }, telegramCall: () => { throw new Error("no network"); } }));

import type { BotClient, InlineKeyboard, TelegramCallback } from "@/lib/notify/telegram-bot";
import type { DecideOutcome } from "./proposals-db";
import { ACTIONS, type Proposal, type ProposalAction } from "./proposals-types";
import {
  type ApprovalDeps, approvalKeyboard, callbackKey, CONFIRM_MS, confirmKeyboard, noticeText, proposalCallback, signCallback, statusLine, TEXT, verifyCallback,
} from "./telegram-approvals";

const KEY = callbackKey(randomBytes(32).toString("base64"));
const ID = "0b8a7a52-1d1e-4c39-9b1e-7d6a3f2c9e01";
const NOW = new Date("2026-10-16T03:00:00.000Z");
const SITE = "https://watchpost.example.test";
const BOOK = { db: [], app: [] };
const OWNER = { memberId: "mem-1", userId: "user-1" };

function proposal(over: Partial<Proposal> & { action?: ProposalAction } = {}): Proposal {
  const action = over.action ?? "vercel_redeploy";
  return {
    id: ID, room: "workloads", action, actionLabel: ACTIONS[action].label, risk: ACTIONS[action].risk, title: "Redeploy production app-a",
    reason: "Error rate di atas 5%.", resourceName: null, proposedBy: "Workloads officer", status: "pending", auto: false, result: null,
    createdAt: NOW.toISOString(), decidedAt: null, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), ...over,
  };
}

// A fake Telegram: every answer and edit, in order.
type Ev = { answer: string } | { text: string; keyboard: InlineKeyboard | null } | { keyboard: InlineKeyboard };
function fakeClient() {
  const ev: Ev[] = [];
  const client: BotClient = {
    answer: async (_q, text) => { ev.push({ answer: text }); },
    editText: async (_c, _m, html, keyboard) => { ev.push({ text: html, keyboard }); },
    editKeyboard: async (_c, _m, keyboard) => { ev.push({ keyboard }); },
    send: async () => { throw new Error("not used"); },
  };
  return { client, ev };
}

let tg: ReturnType<typeof fakeClient>;
let current: Proposal | null;
let deps: ApprovalDeps;
let decide: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tg = fakeClient();
  current = proposal();
  decide = vi.fn(async (_id: string, decision: "approve" | "reject", _m: unknown, _now: Date, opts?: { onApproved?: (p: Proposal) => Promise<void> }): Promise<DecideOutcome> => {
    if (!current || current.status !== "pending") return current ? { status: "conflict", proposal: current } : { status: "missing" };
    if (decision === "reject") {
      current = { ...current, status: "rejected" };
      return { status: "ok", proposal: current };
    }
    current = { ...current, status: "approved" };
    await opts?.onApproved?.(current);
    current = { ...current, status: "done", result: "Redeploy started." };
    return { status: "ok", proposal: current };
  });
  deps = {
    key: () => KEY, get: vi.fn(async () => current), decide: decide as unknown as ApprovalDeps["decide"], book: async () => BOOK, siteUrl: () => SITE, lang: async () => "en" as const,
    audit: vi.fn(async () => undefined),
  };
});

const tap = (data: string): TelegramCallback => ({ queryId: "q1", data, chatId: "-100200300", messageId: 9 });
const run = (data: string, now = NOW) => proposalCallback(tap(data), { client: tg.client, owner: OWNER, now }, deps);
const datas = (k: InlineKeyboard) => k.inline_keyboard.flat().map((b) => b.callback_data);

describe("HMAC callback data", () => {
  it("round-trips, fits Telegram's 64 bytes", () => {
    for (const [op, exp] of [["a", null], ["r", null], ["x", null], ["c", 1_792_000_000]] as const) {
      const d = signCallback(KEY, ID, op, exp);
      expect(d.length).toBeLessThanOrEqual(64);
      expect(d.startsWith(`p:${ID}:${op}`)).toBe(true);
      expect(verifyCallback(KEY, d)).toEqual({ id: ID, op, exp });
    }
  });
  it("refuses a forged, altered or foreign-key callback", () => {
    const d = signCallback(KEY, ID, "r");
    expect(verifyCallback(KEY, d.replace(":r:", ":a:"))).toBeNull();
    expect(verifyCallback(KEY, `p:${ID}:a`)).toBeNull();
    expect(verifyCallback(KEY, `p:${ID}:a:AAAAAAAAAAAAAAAA`)).toBeNull();
    expect(verifyCallback(callbackKey(randomBytes(32).toString("base64")), d)).toBeNull();
    const c = signCallback(KEY, ID, "c", 100);
    expect(verifyCallback(KEY, c.replace(":c:2s:", ":c:zz:"))).toBeNull();
    expect(verifyCallback(KEY, "")).toBeNull();
  });
  it("a forged tap decides nothing", async () => {
    await run(`p:${ID}:a:AAAAAAAAAAAAAAAA`);
    expect(tg.ev).toEqual([{ answer: TEXT.en.invalid }]);
    expect(decide).not.toHaveBeenCalled();
    expect(deps.get).not.toHaveBeenCalled();
  });
});

describe("safe actions", () => {
  it("approve runs at once: waiting → running → ✅ done, buttons removed, audited with the owner", async () => {
    current = proposal({ action: "recheck" });
    await run(signCallback(KEY, ID, "a"));
    expect(decide).toHaveBeenCalledWith(ID, "approve", { id: "mem-1", userId: "user-1" }, NOW, expect.anything());
    expect(tg.ev[0]).toEqual({ answer: TEXT.en.running });
    expect(tg.ev.slice(1).map((e) => ("text" in e ? [e.text.split("\n").pop(), e.keyboard] : e))).toEqual([
      ["Status: ⚙️ running", null],
      ["Status: ✅ done — Redeploy started.", null],
    ]);
    expect(tg.ev.filter((e) => "answer" in e)).toHaveLength(1);
    expect(deps.audit).toHaveBeenCalledWith({ kind: "ok", message: ACTIONS_COPY.telegramDecided("approved", "Redeploy production app-a"), actorUserId: "user-1" });
  });
  it("the Discord history is flushed last: after answer, show and audit; a hung flush is never awaited before them", async () => {
    current = proposal({ action: "recheck" });
    const order: string[] = [];
    (deps.audit as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push("audit"); });
    decide.mockImplementationOnce(async () => ({
      status: "ok", proposal: { ...current!, status: "done", result: "Ok." },
      flushHistory: async () => { order.push(`flush after ${tg.ev.length} telegram calls`); },
    }));
    await run(signCallback(KEY, ID, "r"));
    expect(order).toEqual(["audit", "flush after 2 telegram calls"]);
  });
  it("a failed run shows ❌ failed with the result", async () => {
    current = proposal({ action: "recheck" });
    decide.mockImplementationOnce(async (_i: string, _d: string, _m: unknown, _n: Date, opts?: { onApproved?: (p: Proposal) => Promise<void> }) => {
      await opts?.onApproved?.({ ...current!, status: "approved" });
      return { status: "ok", proposal: { ...current!, status: "failed", result: "Vercel said no." } };
    });
    await run(signCallback(KEY, ID, "a"));
    const last = tg.ev.at(-1) as { text: string };
    expect(last.text.split("\n").pop()).toBe("Status: ❌ failed — Vercel said no.");
  });
});

describe("the risky two-step flow", () => {
  it("first tap only swaps the buttons for [⚠️ Sure? Approve, Cancel], valid 2 minutes", async () => {
    await run(signCallback(KEY, ID, "a"));
    expect(decide).not.toHaveBeenCalled();
    const kb = (tg.ev[0] as { keyboard: InlineKeyboard }).keyboard;
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual([TEXT.en.sure, TEXT.en.cancel]);
    expect(datas(kb)).toEqual(datas(confirmKeyboard(KEY, ID, Math.floor((NOW.getTime() + CONFIRM_MS) / 1000))));
    expect(tg.ev[1]).toEqual({ answer: TEXT.en.confirmFirst });
  });
  it("the second tap within 2 minutes approves", async () => {
    await run(signCallback(KEY, ID, "a"));
    const sure = datas((tg.ev[0] as { keyboard: InlineKeyboard }).keyboard)[0];
    await run(sure, new Date(NOW.getTime() + 90_000));
    expect(decide).toHaveBeenCalledTimes(1);
    expect((tg.ev.at(-1) as { text: string }).text).toContain("Status: ✅ done");
  });
  it("after 2 minutes the confirmation is refused and the two buttons come back", async () => {
    await run(signCallback(KEY, ID, "a"));
    const sure = datas((tg.ev[0] as { keyboard: InlineKeyboard }).keyboard)[0];
    tg.ev.length = 0;
    await run(sure, new Date(NOW.getTime() + CONFIRM_MS + 1_000));
    expect(decide).not.toHaveBeenCalled();
    expect(tg.ev).toEqual([{ keyboard: approvalKeyboard(KEY, ID) }, { answer: TEXT.en.confirmLate }]);
  });
  it("Cancel brings the two buttons back without deciding", async () => {
    await run(signCallback(KEY, ID, "x"));
    expect(decide).not.toHaveBeenCalled();
    expect(tg.ev).toEqual([{ keyboard: approvalKeyboard(KEY, ID) }, { answer: TEXT.en.cancelled }]);
  });
  it("reject needs no confirmation: 🚫 rejected, buttons removed", async () => {
    await run(signCallback(KEY, ID, "r"));
    expect(decide).toHaveBeenCalledWith(ID, "reject", { id: "mem-1", userId: "user-1" }, NOW, expect.anything());
    expect(tg.ev[0]).toEqual({ answer: TEXT.en.rejected });
    expect(tg.ev[1]).toMatchObject({ keyboard: null });
    expect((tg.ev[1] as { text: string }).text.split("\n").pop()).toBe("Status: 🚫 rejected");
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ message: ACTIONS_COPY.telegramDecided("rejected", "Redeploy production app-a") }));
  });
});

describe("already decided or expired", () => {
  it("answers 'already decided / expired' and removes the buttons", async () => {
    current = proposal({ status: "done", result: "Done." });
    await run(signCallback(KEY, ID, "r"));
    expect(decide).not.toHaveBeenCalled();
    expect(tg.ev[0]).toEqual({ answer: TEXT.en.gone });
    expect(tg.ev[1]).toMatchObject({ keyboard: null });
    expect((tg.ev[1] as { text: string }).text).toContain("Status: ✅ done — Done.");
  });
  it("a pending proposal past its time counts as expired", async () => {
    current = proposal({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    await run(signCallback(KEY, ID, "a"));
    expect(decide).not.toHaveBeenCalled();
    expect(tg.ev[0]).toEqual({ answer: TEXT.en.gone });
  });
  it("lost the race (decided elsewhere between read and write): same answer", async () => {
    current = proposal({ action: "recheck" });
    decide.mockResolvedValueOnce({ status: "conflict", proposal: { ...current, status: "rejected" } });
    await run(signCallback(KEY, ID, "a"));
    expect(tg.ev[0]).toEqual({ answer: TEXT.en.gone });
    expect(deps.audit).not.toHaveBeenCalled();
  });
  it("an unknown proposal: answered, buttons removed", async () => {
    current = null;
    await run(signCallback(KEY, ID, "a"));
    expect(tg.ev).toEqual([{ answer: TEXT.en.gone }, { keyboard: { inline_keyboard: [] } }]);
  });
});

describe("message text", () => {
  it("keeps the Auto-actions link and adds the status line", () => {
    const text = noticeText(proposal(), BOOK, SITE);
    expect(text).toContain(`Open in Auto-actions: ${SITE}/auto-actions?proposal=${ID}`);
    expect(text.split("\n").pop()).toBe("Status: ⏳ waiting");
    expect(statusLine(proposal({ status: "failed", result: "<b>no</b>" }), BOOK)).toBe("Status: ❌ failed — &lt;b&gt;no&lt;/b&gt;");
  });
  // Watchbell 1.2.2 (D18): the edited notice reads the real names, like the alert messages in the same chat.
  it("names the real app and database, in English and Indonesian", () => {
    const named = { db: [{ id: "d1", name: "orders-db", alias: "db-a" }], app: [{ id: "a1", name: "shop", alias: "app-a" }] };
    const p = proposal({ title: "Redeploy production app-a", status: "done", result: "Redeploy of app-a started; db-a untouched." });
    expect(statusLine(p, named)).toBe("Status: ✅ done — Redeploy of shop started; orders-db untouched.");
    expect(statusLine(p, named, "id")).toBe("Status: ✅ selesai — Redeploy of shop started; orders-db untouched.");
    expect(noticeText(p, named, SITE)).toContain("Redeploy production shop");
  });
});

describe("Indonesian (notify.language = id)", () => {
  beforeEach(() => { deps.lang = async () => "id" as const; });
  const labels = (kb: InlineKeyboard) => kb.inline_keyboard[0].map((b) => b.text);
  it("buttons are translated, callback data is not", () => {
    expect(labels(approvalKeyboard(KEY, ID, "id"))).toEqual(["✅ Setujui", "❌ Tolak"]);
    expect(datas(approvalKeyboard(KEY, ID, "id"))).toEqual(datas(approvalKeyboard(KEY, ID, "en")));
    expect(labels(confirmKeyboard(KEY, ID, 100, "id"))).toEqual(["⚠️ Yakin? Setujui", "Batal"]);
    expect(datas(confirmKeyboard(KEY, ID, 100, "id"))).toEqual(datas(confirmKeyboard(KEY, ID, 100, "en")));
  });
  it("status lines and notice", () => {
    expect(statusLine(proposal({ status: "approved" }), BOOK, "id")).toBe("Status: ⚙️ jalan");
    expect(statusLine(proposal({ status: "done", result: "Siap." }), BOOK, "id")).toBe("Status: ✅ selesai — Siap.");
    expect(statusLine(proposal({ status: "expired" }), BOOK, "id")).toBe("Status: ⌛ kedaluwarsa");
    expect(noticeText(proposal(), BOOK, SITE, "id").split("\n").pop()).toBe("Status: ⏳ menunggu");
  });
  it("a risky tap gets the Indonesian confirm toast and buttons; the run shows Indonesian statuses", async () => {
    await run(signCallback(KEY, ID, "a"));
    expect(labels((tg.ev[0] as { keyboard: InlineKeyboard }).keyboard)).toEqual(["⚠️ Yakin? Setujui", "Batal"]);
    expect(tg.ev[1]).toEqual({ answer: "Aksi ini berisiko. Tap ⚠️ Yakin? Setujui dalam 2 menit." });
    tg.ev.length = 0;
    await run(datas(confirmKeyboard(KEY, ID, Math.floor(NOW.getTime() / 1000) + 60))[0]);
    expect(tg.ev[0]).toEqual({ answer: "Disetujui. Lagi jalan…" });
    expect((tg.ev.at(-1) as { text: string }).text.split("\n").pop()).toBe("Status: ✅ selesai — Redeploy started.");
  });
  it("invalid, gone and reject toasts", async () => {
    await run("p:bad");
    expect(tg.ev[0]).toEqual({ answer: "Tombol ini nggak valid." });
  });
});
