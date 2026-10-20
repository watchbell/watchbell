import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BotClient, parseUpdate } from "./telegram-bot";
import { handleUpdate, MSG, type UpdateDeps } from "./telegram-updates";

const CHAT = "-100200300";
const OWNER_TG = "4242";
const NOW = new Date("2026-10-16T03:00:00.000Z");

function client() {
  const log: string[] = [];
  const c: BotClient = {
    answer: vi.fn(async (_q: string, text: string) => { log.push(`answer:${text}`); }),
    editText: vi.fn(async () => { log.push("editText"); }),
    editKeyboard: vi.fn(async () => { log.push("editKeyboard"); }),
    send: vi.fn(async (_c: string, html: string) => { log.push(`send:${html}`); }),
  };
  return { c, log };
}

let c: ReturnType<typeof client>;
let deps: UpdateDeps;
beforeEach(() => {
  c = client();
  deps = {
    client: c.c,
    connectedChat: vi.fn(async () => CHAT),
    owner: vi.fn(async () => ({ telegramUserId: OWNER_TG, memberId: "mem-1", userId: "user-1" })),
    redeem: vi.fn(async () => "linked" as const),
    seen: vi.fn(async () => undefined),
    onCallback: vi.fn(async () => undefined),
    lang: async () => "en" as const,
  };
});

const tap = (from: string, chat = CHAT, data = "p:x") => parseUpdate({ update_id: 1, callback_query: { id: "q1", from: { id: Number(from) }, data, message: { message_id: 9, chat: { id: Number(chat), type: "group", title: "Ops" } } } })!;
const text = (t: string, from = OWNER_TG, chat = CHAT) => parseUpdate({ update_id: 2, message: { message_id: 3, chat: { id: Number(chat), type: "group", title: "Ops" }, from: { id: Number(from) }, text: t } })!;

describe("owner-only decisions", () => {
  it("passes the owner's tap in the connected chat to the handler, with the owner's member", async () => {
    await handleUpdate(tap(OWNER_TG), deps, NOW);
    expect(deps.onCallback).toHaveBeenCalledWith({ queryId: "q1", data: "p:x", chatId: CHAT, messageId: 9 }, { client: c.c, owner: { memberId: "mem-1", userId: "user-1" }, now: NOW });
  });
  it("anyone else gets 'Not you 🙂' and nothing happens", async () => {
    await handleUpdate(tap("777"), deps, NOW);
    expect(c.log).toEqual([`answer:${MSG.en.notYou}`]);
    expect(deps.onCallback).not.toHaveBeenCalled();
  });
  it("the owner in another chat is refused too", async () => {
    await handleUpdate(tap(OWNER_TG, "-999"), deps, NOW);
    expect(c.log).toEqual([`answer:${MSG.en.notYou}`]);
    expect(deps.onCallback).not.toHaveBeenCalled();
  });
  it("nobody linked, or no chat connected: refused", async () => {
    deps.owner = vi.fn(async () => null);
    await handleUpdate(tap(OWNER_TG), deps, NOW);
    deps.owner = vi.fn(async () => ({ telegramUserId: OWNER_TG, memberId: "m", userId: "u" }));
    deps.connectedChat = vi.fn(async () => null);
    await handleUpdate(tap(OWNER_TG), deps, NOW);
    expect(c.log).toEqual([`answer:${MSG.en.notYou}`, `answer:${MSG.en.notYou}`]);
    expect(deps.onCallback).not.toHaveBeenCalled();
  });
  it("without a handler (no private feature) the button is inactive", async () => {
    deps.onCallback = null;
    await handleUpdate(tap(OWNER_TG), deps, NOW);
    expect(c.log).toEqual([`answer:${MSG.en.notActive}`]);
  });
});

describe("/link", () => {
  it("links the sender in the connected chat and says so", async () => {
    await handleUpdate(text("/link abcd2345", "5151"), deps, NOW);
    expect(deps.redeem).toHaveBeenCalledWith("ABCD2345", "5151", NOW);
    expect(c.log[0]).toMatch(/^send:✅ Your Telegram account is linked/);
  });
  it("tells a wrong or expired code", async () => {
    deps.redeem = vi.fn(async () => "expired" as const);
    await handleUpdate(text("/link ABCD2345"), deps, NOW);
    deps.redeem = vi.fn(async () => "wrong" as const);
    await handleUpdate(text("/link ABCD2345"), deps, NOW);
    expect(c.log).toEqual([expect.stringContaining("expired"), expect.stringContaining("Wrong code")]);
  });
  it("stays silent outside the connected chat and for other text", async () => {
    await handleUpdate(text("/link ABCD2345", OWNER_TG, "-555"), deps, NOW);
    await handleUpdate(text("halo"), deps, NOW);
    expect(deps.redeem).not.toHaveBeenCalled();
    expect(c.log).toEqual([]);
  });
});

describe("seen chats", () => {
  it("remembers the chat of a message or a tap, with its title", async () => {
    await handleUpdate(text("/start"), deps, NOW);
    await handleUpdate(tap("777"), deps, NOW);
    expect(deps.seen).toHaveBeenNthCalledWith(1, { id: CHAT, label: "Ops (group)" }, NOW);
    expect(deps.seen).toHaveBeenCalledTimes(2);
  });
  it("never throws, even when everything fails", async () => {
    deps.seen = vi.fn(async () => { throw new Error("db down"); });
    deps.connectedChat = vi.fn(async () => { throw new Error("db down"); });
    await expect(handleUpdate(tap(OWNER_TG), deps, NOW)).resolves.toBeUndefined();
    await expect(handleUpdate(parseUpdate({ update_id: 5 })!, deps, NOW)).resolves.toBeUndefined();
  });
});

describe("Indonesian replies (notify.language = id)", () => {
  beforeEach(() => { deps.lang = async () => "id" as const; });
  it("refusals and the inactive-button answer", async () => {
    await handleUpdate(tap("777"), deps, NOW);
    deps.onCallback = null;
    await handleUpdate(tap(OWNER_TG), deps, NOW);
    expect(c.log).toEqual(["answer:Bukan kamu 🙂", "answer:Tombol ini udah nggak aktif."]);
  });
  it("the link-code replies", async () => {
    await handleUpdate(text("/link ABCD2345"), deps, NOW);
    deps.redeem = vi.fn(async () => "wrong" as const);
    await handleUpdate(text("/link ABCD2345"), deps, NOW);
    deps.redeem = vi.fn(async () => "expired" as const);
    await handleUpdate(text("/link ABCD2345"), deps, NOW);
    expect(c.log).toEqual([
      "send:✅ Akun Telegram kamu tersambung. Tombol Setujui / Tolak sekarang cuma nurut sama kamu.",
      "send:Kode salah. Ambil kode baru di Alerts → Notifications kalau perlu.",
      "send:Kodenya udah kedaluwarsa. Ambil kode baru di Alerts → Notifications.",
    ]);
  });
  it("a failing language read falls back to English", async () => {
    deps.lang = async () => { throw new Error("db"); };
    await handleUpdate(tap("777"), deps, NOW);
    expect(c.log).toEqual([`answer:${MSG.en.notYou}`]);
  });
});
