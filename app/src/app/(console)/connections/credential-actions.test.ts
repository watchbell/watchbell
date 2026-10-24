import { beforeEach, describe, expect, it, vi } from "vitest";
import { accounts } from "@/db/schema";
import { fakeDb } from "@/lib/data/fake-db";

// 1.2 (spec §7): Test connection runs the provider's own check and never saves; Save always tests first. No provider
// is contacted: the check itself is stubbed.
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  requireActionMember: vi.fn(), revalidatePath: vi.fn(), test: vi.fn(), limit: vi.fn(), order: [] as string[],
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath, updateTag: vi.fn() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }) }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/providers/test-connection", () => ({ testConnection: h.test }));

import { addAccount, checkCredential } from "./actions";

const NEON_KEY = "napi_0123456789abcdefghijklmnop";

beforeEach(() => {
  h.requireActionMember.mockReset().mockResolvedValue(member);
  h.revalidatePath.mockReset();
  h.limit.mockReset().mockResolvedValue({ allowed: true });
  h.order = [];
  h.test.mockReset().mockImplementation(async () => {
    h.order.push("test");
    return { ok: true, summary: "Found 2 projects", details: ["Every permission it needs is there"] };
  });
});

describe("Test connection", () => {
  it("runs the provider's check and writes nothing", async () => {
    const fake = fakeDb([]);
    h.current = fake;
    const r = await checkCredential("neon", `  ${NEON_KEY} `);
    expect(r).toEqual({ ok: true, data: { ok: true, summary: "Found 2 projects", details: ["Every permission it needs is there"] } });
    expect(h.test).toHaveBeenCalledWith("neon", NEON_KEY);
    expect(fake.writes).toEqual([]);
    expect(fake.queries).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("a rejected credential is reported, still without a write", async () => {
    const fake = fakeDb([]);
    h.current = fake;
    h.test.mockResolvedValue({ ok: false, kind: "auth", error: "Neon rejected this credential (401). Check that you copied all of it." });
    const r = await checkCredential("neon", NEON_KEY);
    expect(r).toEqual({ ok: true, data: { ok: false, kind: "auth", error: "Neon rejected this credential (401). Check that you copied all of it." } });
    expect(fake.writes).toEqual([]);
  });

  it("is owner only and rate-limited like adding an account", async () => {
    h.current = fakeDb([]);
    await checkCredential("neon", NEON_KEY);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).toHaveBeenCalledWith(expect.objectContaining({ name: "credential" }), "mem-1");
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect((await checkCredential("neon", NEON_KEY)).ok).toBe(false);
    expect(h.test).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown provider or a malformed credential before calling anyone", async () => {
    h.current = fakeDb([]);
    expect(await checkCredential("jenkins", NEON_KEY)).toEqual({ ok: false, error: "Unknown provider." });
    const short = await checkCredential("neon", "short");
    expect(!short.ok && short.fieldErrors?.credential).toBeTruthy();
    expect(h.test).not.toHaveBeenCalled();
  });
});

describe("Save", () => {
  it("tests first and saves nothing when the test fails", async () => {
    const fake = fakeDb([[]]);
    h.current = fake;
    h.test.mockResolvedValue({ ok: false, kind: "auth", error: "Neon rejected this credential (401). Check that you copied all of it." });
    const r = await addAccount("neon", "utama", NEON_KEY);
    expect(r.ok).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("saves after a passing test, keeping what the check found about the token's access", async () => {
    const fake = fakeDb([[]]);
    h.current = fake;
    h.test.mockImplementation(async () => {
      h.order.push("test");
      return { ok: true, summary: "Found 1 zone", details: [], scopeNote: "Zone, DNS, SSL and Certificates read · D1 read" };
    });
    const r = await addAccount("neon", "utama", NEON_KEY);
    expect(r.ok).toBe(true);
    expect(h.order).toEqual(["test"]);
    expect(fake.writes.map((w) => [w.kind, w.table])).toEqual([["insert", accounts]]);
    const values = fake.writes[0].calls.find((c) => c.method === "values")?.args[0] as Record<string, unknown>;
    expect(values.scopeNote).toBe("Zone, DNS, SSL and Certificates read · D1 read");
    expect(values.credentialCiphertext).not.toContain(NEON_KEY);
  });
});
