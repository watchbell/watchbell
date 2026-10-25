import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers } from "@/db/schema";
import { hashToken } from "@/lib/local-auth/session-token";
import { base32Decode } from "@/lib/local-auth/totp";

const KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  jar: new Map<string, { value: string; options?: unknown }>(),
  supabase: {
    getClaims: async () => ({ data: { claims: { sub: "cloud-user", email: "c@example.com", aal: "aal1" } } }),
    listFactors: async () => ({ data: { all: [], totp: [{ id: "f1", status: "verified" }] }, error: null }),
    // Set by the cloud test.
    challengeAndVerify: undefined as unknown as (a: { factorId: string; code: string }) => Promise<{ error: unknown }>,
  },
}));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64, SITE_URL: "http://127.0.0.1:3100" }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "test-browser" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => void h.jar.set(name, { value, options }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: () => h.supabase.getClaims(),
      mfa: { listFactors: () => h.supabase.listFactors(), challengeAndVerify: (a: { factorId: string; code: string }) => h.supabase.challengeAndVerify(a) },
    },
  }),
}));

import { demoCookieKey, signDemoCookie } from "@/lib/demo/cookie";
import { createLocalSession, readLocalSession } from "@/lib/local-auth/sessions-db";
import { confirmMfaEnrollment, type MfaFormState, startMfaEnrollment, verifyMfaCode } from "./actions";

function codeAt(secret: string, ms: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
// 10 s into a 30 s step.
const T = Date.UTC(2026, 9, 19, 12, 0, 10);
const IDLE: MfaFormState = { status: "idle" };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 120_000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  h.jar.clear();
  for (const t of ["local_users", "rate_limits"]) await db.execute(sql.raw(`delete from ops.${t}`));
  [{ id: userId }] = await db
    .insert(localUsers)
    .values({ email: "ana@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" })
    .returning({ id: localUsers.id });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function signedInAal1() {
  const { token } = await createLocalSession(userId, { aal: "aal1" });
  h.jar.set("wp_session", { value: token });
  return token;
}

describe("MFA actions in self-host", () => {
  beforeEach(() => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    // Frozen clock: the codes below are computed for T, so no 30 s step boundary can pass mid-test.
    vi.useFakeTimers({ toFake: ["Date"], now: T });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enroll → confirm turns the factor on and swaps the aal1 session for a new aal2 one", async () => {
    const old = await signedInAal1();
    const e = await startMfaEnrollment();
    if (!e.ok) throw new Error(e.error);
    expect(e.qr.startsWith("data:image/svg+xml")).toBe(true);
    expect(e.secret).toMatch(/^[A-Z2-7]{32}$/);

    const state = await confirmMfaEnrollment(IDLE, form({ code: codeAt(e.secret, T), factorId: e.factorId }));
    expect(state).toEqual({ status: "done" });
    const fresh = h.jar.get("wp_session")!;
    expect(fresh.value).not.toBe(old);
    expect(fresh.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(await readLocalSession(old)).toBeNull();
    expect(await readLocalSession(fresh.value)).toMatchObject({ userId, aal: "aal2" });
    const [row] = await db.select().from(localUsers).where(eq(localUsers.id, userId));
    expect(row.totpConfirmedAt).not.toBeNull();
    const all = await db.select().from(localSessions).where(eq(localSessions.userId, userId));
    expect(all.map((s) => s.tokenHash)).toEqual([hashToken(fresh.value)]);
  });

  it("verify with a replayed code fails; a wrong code fails; neither touches the session", async () => {
    await signedInAal1();
    const e = await startMfaEnrollment();
    if (!e.ok) throw new Error(e.error);
    const code = codeAt(e.secret, T);
    expect(await confirmMfaEnrollment(IDLE, form({ code, factorId: e.factorId }))).toEqual({ status: "done" });

    // A new aal1 sign-in, then the same code again.
    const second = await signedInAal1();
    const replay = await verifyMfaCode(IDLE, form({ code }));
    expect(replay).toMatchObject({ status: "error" });
    expect(h.jar.get("wp_session")!.value).toBe(second);
    expect(await readLocalSession(second)).toMatchObject({ aal: "aal1" });
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifyMfaCode(IDLE, form({ code: wrong }))).toMatchObject({ status: "error" });
  });

  it("verify with a fresh code (next step) upgrades by rotation", async () => {
    await signedInAal1();
    const e = await startMfaEnrollment();
    if (!e.ok) throw new Error(e.error);
    // Confirm with the previous step's code (accepted: one step of skew), so the current one is still unused.
    expect(await confirmMfaEnrollment(IDLE, form({ code: codeAt(e.secret, T - 30_000), factorId: e.factorId }))).toEqual({ status: "done" });
    const second = await signedInAal1();
    expect(await verifyMfaCode(IDLE, form({ code: codeAt(e.secret, T) }))).toEqual({ status: "done" });
    expect(await readLocalSession(second)).toBeNull();
    expect(await readLocalSession(h.jar.get("wp_session")!.value)).toMatchObject({ aal: "aal2" });
  });

  it("sends a user who must change the password to /account/password after the code", async () => {
    await db.update(localUsers).set({ mustChangePassword: true }).where(eq(localUsers.id, userId));
    await signedInAal1();
    const e = await startMfaEnrollment();
    if (!e.ok) throw new Error(e.error);
    expect(await confirmMfaEnrollment(IDLE, form({ code: codeAt(e.secret, T), factorId: e.factorId }))).toEqual({
      status: "done",
      next: "/account/password",
    });
  });

  it("verify without a confirmed factor goes to setup; a second enrollment after confirming is refused", async () => {
    await signedInAal1();
    await expect(verifyMfaCode(IDLE, form({ code: "123456" }))).rejects.toThrow("REDIRECT /mfa/setup");
    const e = await startMfaEnrollment();
    if (!e.ok) throw new Error(e.error);
    expect(await confirmMfaEnrollment(IDLE, form({ code: codeAt(e.secret, T), factorId: e.factorId }))).toEqual({ status: "done" });
    expect(await startMfaEnrollment()).toMatchObject({ ok: false });
  });

  it("is rate limited per user (5 codes per 5 minutes)", async () => {
    await signedInAal1();
    await startMfaEnrollment();
    for (let i = 0; i < 5; i++) await confirmMfaEnrollment(IDLE, form({ code: "000000", factorId: "local" }));
    expect(await confirmMfaEnrollment(IDLE, form({ code: "000000", factorId: "local" }))).toMatchObject({
      status: "error",
      message: expect.stringMatching(/^Too many codes tried/),
    });
  });

  it("without a session goes to sign-in", async () => {
    await expect(startMfaEnrollment()).rejects.toThrow("REDIRECT /signin");
  });
});

describe("MFA actions in the cloud (unchanged)", () => {
  it("confirm and verify go to Supabase and finish with a plain done (reload to /)", async () => {
    const calls: { factorId: string; code: string }[] = [];
    h.supabase.challengeAndVerify = async (a) => {
      calls.push(a);
      return { error: null };
    };
    expect(await confirmMfaEnrollment(IDLE, form({ code: "123456", factorId: "f9" }))).toEqual({ status: "done" });
    expect(await verifyMfaCode(IDLE, form({ code: "654321" }))).toEqual({ status: "done" });
    expect(calls).toEqual([
      { factorId: "f9", code: "123456" },
      { factorId: "f1", code: "654321" },
    ]);
    expect(h.jar.size).toBe(0);
    expect(await db.select().from(localSessions)).toHaveLength(0);
  });
});

// Review m4: only a wrong code counts towards the back-off and the alert; Supabase's other errors don't.
describe("MFA actions in the cloud: what counts as a wrong code", () => {
  const counted = async () => (await db.execute(sql`select count(*)::int as n from ops.rate_limits where key like 'mfa-code-backoff:%'`)).rows;
  it("mfa_verification_failed is a wrong code and counts; an expired challenge or a Supabase hiccup doesn't", async () => {
    await db.execute(sql`delete from ops.rate_limits`);
    h.supabase.challengeAndVerify = async () => ({ error: { code: "mfa_challenge_expired", status: 422 } });
    expect(await verifyMfaCode(IDLE, form({ code: "654321" }))).toEqual({ status: "error", message: "Couldn't check the code right now. Try again." });
    expect(await counted()).toEqual([{ n: 0 }]);
    h.supabase.challengeAndVerify = async () => ({ error: { code: "mfa_verification_failed", status: 422 } });
    expect(await verifyMfaCode(IDLE, form({ code: "654321" }))).toMatchObject({ status: "error", message: expect.stringContaining("didn't work") });
    expect(await counted()).toEqual([{ n: 1 }]);
  });
});

describe("MFA actions in the demo", () => {
  const NO_MFA = "Two-step sign-in isn't used in the demo.";
  beforeEach(() => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    h.supabase.getClaims = async () => {
      throw new Error("Supabase must not be asked in the demo");
    };
    h.supabase.challengeAndVerify = async () => {
      throw new Error("Supabase must not be asked in the demo");
    };
  });

  it("a signed-in visitor is told the demo has no two-step sign-in, with no Supabase, limiter or session work", async () => {
    h.jar.set("wp_demo", { value: signDemoCookie({ email: "ana@visitor.test", seed: "0123456789abcdef0123456789abcdef" }, demoCookieKey(KEY_B64)) });
    expect(await startMfaEnrollment()).toEqual({ ok: false, error: NO_MFA });
    expect(await confirmMfaEnrollment(IDLE, form({ code: "123456", factorId: "f9" }))).toEqual({ status: "error", message: NO_MFA });
    expect(await verifyMfaCode(IDLE, form({ code: "123456" }))).toEqual({ status: "error", message: NO_MFA });
    expect(await db.select().from(localSessions)).toHaveLength(0);
    expect((await db.execute(sql`select count(*)::int as n from ops.rate_limits`)).rows).toEqual([{ n: 0 }]);
    expect([...h.jar.keys()]).toEqual(["wp_demo"]);
  });

  it("without a valid demo cookie goes to sign-in (a self-host session cookie counts for nothing)", async () => {
    h.jar.set("wp_session", { value: "t".repeat(43) });
    await expect(startMfaEnrollment()).rejects.toThrow("REDIRECT /signin");
    await expect(confirmMfaEnrollment(IDLE, form({ code: "123456", factorId: "f9" }))).rejects.toThrow("REDIRECT /signin");
    h.jar.set("wp_demo", { value: "forged.mac" });
    await expect(verifyMfaCode(IDLE, form({ code: "123456" }))).rejects.toThrow("REDIRECT /signin");
    expect(await db.select().from(localSessions)).toHaveLength(0);
  });
});
