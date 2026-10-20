import { createHmac, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localUsers } from "@/db/schema";
import { base32Decode } from "./totp";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { acceptLocalCode, openTotpSecret, sealTotpSecret, startLocalEnrollment } from "./mfa";

const KEY = randomBytes(32).toString("base64");
const T = Date.UTC(2026, 9, 19, 12, 0, 0);
const STEP = 30_000;

function codeAt(secret: string, ms: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / STEP)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const otherCode = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

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
  await db.execute(sql`delete from ops.local_users`);
  [{ id: userId }] = await db
    .insert(localUsers)
    .values({ email: "ana@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" })
    .returning({ id: localUsers.id });
});

const user = async () => (await db.select().from(localUsers).where(eq(localUsers.id, userId)))[0];

async function enroll() {
  const e = await startLocalEnrollment(userId, "ana@example.com", KEY);
  if (!e.ok) throw new Error(e.error);
  return e;
}

describe("sealed TOTP secret", () => {
  it("round-trips and refuses a wrong key or a damaged value", () => {
    const sealed = sealTotpSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", KEY);
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+$/);
    expect(sealed).not.toContain("JBSWY3DP");
    expect(openTotpSecret(sealed, KEY)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(openTotpSecret(sealed, randomBytes(32).toString("base64"))).toBeNull();
    expect(openTotpSecret(`${sealed}:x`, KEY)).toBeNull();
    expect(openTotpSecret(null, KEY)).toBeNull();
  });
});

describe("self-host TOTP enrollment and codes", () => {
  it("enroll stores the secret sealed only and returns an SVG QR of the otpauth URI plus the key for manual entry", async () => {
    const e = await enroll();
    expect(e.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.qr.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(e.qr.slice(e.qr.indexOf(",") + 1))).toContain("<svg");
    const row = await user();
    expect(row.totpSecretSealed).not.toContain(e.secret);
    expect(openTotpSecret(row.totpSecretSealed, KEY)).toBe(e.secret);
    expect(row.totpConfirmedAt).toBeNull();
  });

  it("confirm with a valid code turns the factor on and stores the step", async () => {
    const e = await enroll();
    expect(await acceptLocalCode(userId, otherCode(codeAt(e.secret, T)), "confirm", KEY, T)).toBe(false);
    expect((await user()).totpConfirmedAt).toBeNull();
    expect(await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", KEY, T)).toBe(true);
    const row = await user();
    expect(row.totpConfirmedAt).not.toBeNull();
    expect(row.totpLastStep).toBe(Math.floor(T / STEP));
  });

  it("refuses a new enrollment once the factor is confirmed (a password alone can't swap the authenticator)", async () => {
    const e = await enroll();
    await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", KEY, T);
    const sealedBefore = (await user()).totpSecretSealed;
    expect(await startLocalEnrollment(userId, "ana@example.com", KEY)).toMatchObject({ ok: false });
    expect((await user()).totpSecretSealed).toBe(sealedBefore);
  });

  it("verify rejects a replayed code and accepts the next step's", async () => {
    const e = await enroll();
    await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", KEY, T);
    // The confirm code again, still inside its window: replay.
    expect(await acceptLocalCode(userId, codeAt(e.secret, T), "verify", KEY, T + 5_000)).toBe(false);
    expect(await acceptLocalCode(userId, codeAt(e.secret, T + STEP), "verify", KEY, T + STEP)).toBe(true);
    expect(await acceptLocalCode(userId, codeAt(e.secret, T + STEP), "verify", KEY, T + STEP + 1_000)).toBe(false);
  });

  it("two submits of the same code at once: only one is accepted", async () => {
    const e = await enroll();
    await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", KEY, T);
    const code = codeAt(e.secret, T + STEP);
    const results = await Promise.all([acceptLocalCode(userId, code, "verify", KEY, T + STEP), acceptLocalCode(userId, code, "verify", KEY, T + STEP)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("verify needs a confirmed factor and confirm needs an unconfirmed one", async () => {
    const e = await enroll();
    expect(await acceptLocalCode(userId, codeAt(e.secret, T), "verify", KEY, T)).toBe(false);
    expect(await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", KEY, T)).toBe(true);
    expect(await acceptLocalCode(userId, codeAt(e.secret, T + STEP), "confirm", KEY, T + STEP)).toBe(false);
  });

  it("a code for a secret replaced by a newer enrollment no longer works", async () => {
    const first = await enroll();
    await enroll();
    expect(await acceptLocalCode(userId, codeAt(first.secret, T), "confirm", KEY, T)).toBe(false);
  });

  it("no secret, or a secret sealed with another key → refused", async () => {
    expect(await acceptLocalCode(userId, "123456", "confirm", KEY, T)).toBe(false);
    const e = await enroll();
    expect(await acceptLocalCode(userId, codeAt(e.secret, T), "confirm", randomBytes(32).toString("base64"), T)).toBe(false);
  });
});

