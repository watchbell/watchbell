import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Answer, fakeDb, payloadOf } from "./fake-db";

const KEY = randomBytes(32).toString("base64");
const h = vi.hoisted(() => ({ db: null as null | (() => unknown) }));
vi.mock("@/db/client", () => ({ db: () => h.db!() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY, SITE_URL: "https://ops.example.test" }) }));

import { seal } from "@/lib/crypto";
import { hashLinkCode } from "@/lib/notify/telegram-bot";
import {
  createLinkCode, forgetWebhookMemo, LINK_KEY, LINK_MAX_TRIES, linkedOwner, nextSeen, OWNER_KEY, readSeenChats, recordSeenChat, redeemLinkCode, SEEN_KEY,
  webhookSecret,
} from "./telegram-bot-db";

const NOW = new Date("2026-10-16T03:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
let fake: ReturnType<typeof fakeDb>;
const use = (reads: Answer[], writes: Answer[] = []) => {
  fake = fakeDb(reads, writes);
  h.db = fake.db;
};
const sealed = (plain: string) => ({ sealed: seal(plain, KEY), at: NOW.toISOString() });

beforeEach(() => forgetWebhookMemo());

describe("/link code", () => {
  it("is stored only as a hash, for 10 minutes", async () => {
    use([]);
    const { code, expiresAt } = await createLinkCode("mem-1", NOW);
    expect(expiresAt).toEqual(later(10 * 60_000));
    const v = payloadOf(fake.writes[0].calls)!;
    expect(v).toEqual({ key: LINK_KEY, value: { hash: hashLinkCode(code), member: "mem-1", expiresAt: expiresAt.toISOString(), tries: 0 } });
    expect(JSON.stringify(v)).not.toContain(code);
  });

  const stored = (code: string, tries = 0, expiresAt = later(10 * 60_000)) => [{ value: { hash: hashLinkCode(code), member: "mem-1", expiresAt: expiresAt.toISOString(), tries } }];

  it("links the owner (sealed) and spends the code", async () => {
    use([stored("ABCD2345"), [{ id: "mem-1" }]]);
    expect(await redeemLinkCode("ABCD2345", "4242", later(60_000))).toBe("linked");
    expect(fake.writes.map((w) => w.kind)).toEqual(["delete", "insert"]);
    const owner = payloadOf(fake.writes[1].calls)!;
    expect(owner.key).toBe(OWNER_KEY);
    expect(JSON.stringify(owner)).not.toContain("4242");
  });

  it("expires after 10 minutes", async () => {
    use([stored("ABCD2345", 0, later(10 * 60_000))]);
    expect(await redeemLinkCode("ABCD2345", "4242", later(10 * 60_000))).toBe("expired");
    expect(fake.writes.map((w) => w.kind)).toEqual(["delete"]);
    use([[]]);
    expect(await redeemLinkCode("ABCD2345", "4242", NOW)).toBe("expired");
  });

  it("counts wrong tries and drops the code at the fifth", async () => {
    use([stored("ABCD2345")]);
    expect(await redeemLinkCode("WXYZ2345", "4242", NOW)).toBe("wrong");
    expect(payloadOf(fake.writes[0].calls)).toMatchObject({ value: { tries: 1 } });
    use([stored("ABCD2345", LINK_MAX_TRIES - 1)]);
    expect(await redeemLinkCode("WXYZ2345", "4242", NOW)).toBe("wrong");
    expect(fake.writes.map((w) => w.kind)).toEqual(["delete"]);
  });

  it("a code whose member is no longer an owner links nobody", async () => {
    use([stored("ABCD2345"), []]);
    expect(await redeemLinkCode("ABCD2345", "4242", NOW)).toBe("expired");
    expect(fake.writes.map((w) => w.kind)).toEqual(["delete"]);
  });
});

describe("linkedOwner", () => {
  it("unseals the Telegram user id and checks the member is still an owner", async () => {
    use([[{ value: sealed(JSON.stringify({ tg: "4242", member: "mem-1" })) }], [{ id: "mem-1", userId: "user-1" }]]);
    expect(await linkedOwner()).toEqual({ telegramUserId: "4242", memberId: "mem-1", userId: "user-1" });
    use([[{ value: sealed(JSON.stringify({ tg: "4242", member: "mem-1" })) }], []]);
    expect(await linkedOwner()).toBeNull();
    use([[{ value: { sealed: { ciphertext: "AAAA", iv: "AAAA" } } }]]);
    expect(await linkedOwner()).toBeNull();
  });
});

describe("webhook secret", () => {
  it("is read sealed and kept 30 s per instance", async () => {
    use([[{ value: sealed("the-secret") }]]);
    expect(await webhookSecret(1_000)).toBe("the-secret");
    expect(await webhookSecret(20_000)).toBe("the-secret");
    expect(fake.queries).toHaveLength(1);
    use([[]]);
    expect(await webhookSecret(40_000)).toBeNull();
  });
});

describe("seen chats", () => {
  it("newest first, at most 10, no write when nothing changed", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `c${i}`, at: NOW.toISOString() }));
    const next = nextSeen(list, { id: "new", label: "New (group)" }, NOW)!;
    expect(next).toHaveLength(10);
    expect(next[0]).toEqual({ id: "new", label: "New (group)", at: NOW.toISOString() });
    expect(nextSeen(next, { id: "new", label: "New (group)" }, later(60_000))).toBeNull();
    expect(nextSeen(next, { id: "new", label: "Renamed (group)" }, later(60_000))?.[0].label).toBe("Renamed (group)");
  });
  it("stores the list sealed: no chat id in clear text", async () => {
    use([[]]);
    await recordSeenChat({ id: "-100777", label: "Ops (group)" }, NOW);
    const v = payloadOf(fake.writes[0].calls)!;
    expect(v.key).toBe(SEEN_KEY);
    expect(JSON.stringify(v)).not.toContain("-100777");
    use([[{ value: (v as { value: unknown }).value }]]);
    expect(await readSeenChats()).toEqual([{ id: "-100777", label: "Ops (group)", at: NOW.toISOString() }]);
  });
});
