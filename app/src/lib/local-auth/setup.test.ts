import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { tmpBase } from "../../../test/tmp-base";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localUsers, members, settings } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { limit, peekLimit } from "@/lib/rate-limit-db";
import { verifyPassword } from "./password";
import { completeSetup, ensureSetupCode, SETUP_CODE_SETTING, setupCodeFile, type SetupInput } from "./setup";
import { hashSetupCode } from "./setup-code";

const KEY = Buffer.alloc(32, 7);
const T0 = new Date("2026-10-19T00:00:00Z");
const HOUR = 3_600_000;
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ipSeq = 0;
// The setup-code file goes to WATCHBELL_DATA_DIR: a scratch folder per test, never the app's ./data.
let dataDir: string;

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
  dataDir = mkdtempSync(join(tmpBase, "wp-setup-"));
  vi.stubEnv("WATCHBELL_DATA_DIR", dataDir);
  await db.execute(sql`delete from ops.members`);
  await db.execute(sql`delete from ops.local_users`);
  await db.execute(sql`delete from ops.settings`);
  await db.execute(sql`delete from ops.rate_limits`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

const stored = async () => (await db.select().from(settings).where(eq(settings.key, SETUP_CODE_SETTING)))[0];

// Starts the server's first-run step and returns the code it printed.
async function printedCode(now = T0): Promise<string> {
  const log = vi.fn();
  await ensureSetupCode({ key: KEY, siteUrl: "http://127.0.0.1:3100/", now, log });
  expect(log).toHaveBeenCalledTimes(1);
  return /setup code: ([A-Z0-9]{5}-[A-Z0-9]{5}) /.exec(log.mock.calls[0][0] as string)![1];
}

const input = (code: string, over: Partial<SetupInput> = {}): SetupInput => ({
  code,
  email: "Owner@Example.com ",
  password: "correct horse battery",
  confirm: "correct horse battery",
  ...over,
});
// Every test gets its own IP so the per-IP limit only matters where a test is about it.
const deps = (over: { ip?: string | null; now?: Date } = {}) => ({
  ip: over.ip === undefined ? `10.0.0.${++ipSeq}` : over.ip,
  key: KEY,
  limit,
  peek: peekLimit,
  now: over.now ?? new Date(T0.getTime() + HOUR),
});
const limitRows = () => db.select().from(schema.rateLimits);

describe("ensureSetupCode", () => {
  it("with no owner prints one code once and stores only its keyed hash, valid 24 h", async () => {
    const log = vi.fn();
    expect(await ensureSetupCode({ key: KEY, siteUrl: "http://127.0.0.1:3100/", now: T0, log })).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(/^Watchbell setup code: [A-Z2-9]{5}-[A-Z2-9]{5} \(open http:\/\/127\.0\.0\.1:3100\/setup; valid 24 h\)$/);
    const code = /code: (\S+)/.exec(line)![1];
    const row = await stored();
    expect(row.value).toEqual({ hash: hashSetupCode(code, KEY), expiresAt: new Date(T0.getTime() + 24 * HOUR).toISOString() });
    expect(JSON.stringify(row.value)).not.toContain(code.replace("-", ""));
  });

  it("also writes the printed code to <WATCHBELL_DATA_DIR>/setup-code, owner-only, replacing an older one", async () => {
    const file = setupCodeFile();
    expect(file).toBe(join(dataDir, "setup-code"));
    const first = await printedCode();
    expect(readFileSync(file, "utf8")).toBe(`${first}\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = await printedCode();
    expect(readFileSync(file, "utf8")).toBe(`${second}\n`);
  });

  it("still prints the code when the file can't be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.fn();
    // Its "folder" is a file, so neither the folder nor the file can be created.
    writeFileSync(join(dataDir, "not-a-folder"), "");
    expect(await ensureSetupCode({ key: KEY, siteUrl: "http://x", log, codeFile: join(dataDir, "not-a-folder", "setup-code") })).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/couldn't write the setup code/));
    warn.mockRestore();
  });

  it("replaces the code on every start while no owner exists", async () => {
    const first = await printedCode();
    const second = await printedCode();
    expect(second).not.toBe(first);
    expect((await stored()).value).toMatchObject({ hash: hashSetupCode(second, KEY) });
  });

  it("with an owner prints nothing and drops a leftover code", async () => {
    await printedCode();
    await db.insert(members).values({ userId: crypto.randomUUID(), email: "o@example.com", role: "owner" });
    const log = vi.fn();
    expect(await ensureSetupCode({ key: KEY, siteUrl: "http://x", log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(await stored()).toBeUndefined();
    expect(existsSync(setupCodeFile())).toBe(false);
  });
});

describe("completeSetup", () => {
  it("creates exactly one owner: a local user and its owner membership, and consumes the code", async () => {
    const code = await printedCode();
    const res = await completeSetup(input(code.toLowerCase()), deps());
    expect(res.status).toBe("ok");
    const users = await db.select().from(localUsers);
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("owner@example.com");
    expect(await verifyPassword("correct horse battery", users[0].passwordHash)).toBe(true);
    expect(users[0].totpConfirmedAt).toBeNull();
    const rows = await db.select().from(members);
    expect(rows).toEqual([expect.objectContaining({ userId: users[0].id, email: "owner@example.com", role: "owner" })]);
    expect(res).toEqual({ status: "ok", userId: users[0].id });
    expect(await stored()).toBeUndefined();
    expect(existsSync(setupCodeFile())).toBe(false);
    // The code is spent: the same submit again finds an owner.
    expect(await completeSetup(input(code), deps())).toEqual({ status: "done" });
  });

  it("refuses once an owner exists, whatever the code", async () => {
    const code = await printedCode();
    await db.insert(members).values({ userId: crypto.randomUUID(), email: "o@example.com", role: "owner" });
    expect(await completeSetup(input(code), deps())).toEqual({ status: "done" });
    expect(await db.select().from(localUsers)).toHaveLength(0);
  });

  it("refuses a wrong code and an expired one", async () => {
    const code = await printedCode();
    const wrong = await completeSetup(input("AAAAA-AAAAA"), deps());
    expect(wrong).toMatchObject({ status: "error", field: "code", message: expect.stringMatching(/wrong/) });
    // A refused code leaves the file for the next try.
    expect(existsSync(setupCodeFile())).toBe(true);
    const expired = await completeSetup(input(code), deps({ now: new Date(T0.getTime() + 24 * HOUR) }));
    expect(expired).toMatchObject({ status: "error", field: "code", message: expect.stringMatching(/expired.*Restart/) });
    expect(await db.select().from(localUsers)).toHaveLength(0);
    expect(await db.select().from(members)).toHaveLength(0);
  });

  it("refuses when no code was ever printed", async () => {
    expect(await completeSetup(input("ABCDE-FGH23"), deps())).toMatchObject({ status: "error", field: "code" });
  });

  it("limits failed codes per known IP: after 5 even the right code waits, another IP doesn't", async () => {
    const code = await printedCode();
    for (let i = 0; i < 5; i++) expect(await completeSetup(input("AAAAA-AAAAA"), deps({ ip: "10.9.9.9" }))).toMatchObject({ field: "code" });
    const blocked = await completeSetup(input(code), deps({ ip: "10.9.9.9" }));
    expect(blocked).toMatchObject({ status: "error", message: expect.stringMatching(/^Too many wrong codes\. Try again in \d+ minutes?, or restart Watchbell\.$/) });
    expect(await db.select().from(localUsers)).toHaveLength(0);
    expect((await completeSetup(input(code), deps({ ip: "10.9.9.10" }))).status).toBe("ok");
  });

  it("counts only failed attempts: a success leaves no counter behind", async () => {
    const code = await printedCode();
    expect((await completeSetup(input(code), deps({ ip: "10.7.7.7" }))).status).toBe("ok");
    expect(await limitRows()).toHaveLength(0);
  });

  it("with no trusted IP keys nothing per IP, and failures from everyone share one cap of 100", async () => {
    const code = await printedCode();
    for (let i = 0; i < 99; i++) await completeSetup(input("AAAAA-AAAAA"), deps({ ip: null }));
    expect(await limitRows()).toEqual([expect.objectContaining({ key: expect.stringMatching(/^setup-all:/), count: 99 })]);
    expect(await completeSetup(input("AAAAA-AAAAA"), deps({ ip: null }))).toMatchObject({ field: "code" });
    // the cap is reached: everyone waits, even with the right code
    expect(await completeSetup(input(code), deps({ ip: null }))).toMatchObject({ message: expect.stringMatching(/^Too many wrong codes/) });
    expect(await completeSetup(input(code), deps({ ip: "10.6.6.6" }))).toMatchObject({ message: expect.stringMatching(/^Too many wrong codes/) });
  }, 30_000);

  it("a restart prints a new code and clears every setup lockout", async () => {
    await printedCode();
    for (let i = 0; i < 5; i++) await completeSetup(input("AAAAA-AAAAA"), deps({ ip: "10.5.5.5" }));
    await db.insert(schema.rateLimits).values({ key: "signin-ip:keep", windowStart: new Date() });
    const fresh = await printedCode();
    expect((await limitRows()).map((r) => r.key)).toEqual(["signin-ip:keep"]);
    expect((await completeSetup(input(fresh), deps({ ip: "10.5.5.5" }))).status).toBe("ok");
  });

  it("checks the form before counting an attempt", async () => {
    const code = await printedCode();
    const ip = "10.8.8.8";
    expect(await completeSetup(input(code, { email: "nope" }), deps({ ip }))).toMatchObject({ field: "email" });
    expect(await completeSetup(input(code, { email: `${"a".repeat(310)}@example.com` }), deps({ ip }))).toMatchObject({ field: "email" });
    expect(await completeSetup(input(code, { password: "short", confirm: "short" }), deps({ ip }))).toMatchObject({ field: "password", message: "Use at least 12 characters." });
    expect(await completeSetup(input(code, { confirm: "correct horse batterz" }), deps({ ip }))).toMatchObject({ field: "confirm" });
    expect(await completeSetup(input(" "), deps({ ip }))).toMatchObject({ field: "code" });
    expect(await db.select().from(schema.rateLimits)).toHaveLength(0);
  });

  it("two submits at the same moment create one owner; the other is told setup is done", async () => {
    const code = await printedCode();
    const results = await Promise.all([
      completeSetup(input(code, { email: "first@example.com" }), deps()),
      completeSetup(input(code, { email: "second@example.com" }), deps()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["done", "ok"]);
    expect(await db.select().from(localUsers)).toHaveLength(1);
    expect(await db.select().from(members)).toHaveLength(1);
  });
});
