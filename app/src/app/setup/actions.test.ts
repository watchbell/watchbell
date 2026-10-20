import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { tmpBase } from "../../../test/tmp-base";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, members } from "@/db/schema";
import { hashToken } from "@/lib/local-auth/session-token";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  jar: new Map<string, { value: string; options?: unknown }>(),
  headers: new Headers(),
}));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64, SITE_URL: "http://127.0.0.1:3100" }) }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => void h.jar.set(name, { value, options }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createLocalSession, readLocalSession } from "@/lib/local-auth/sessions-db";
import { ensureSetupCode } from "@/lib/local-auth/setup";
import { submitSetup } from "./actions";
import SetupPage from "./page";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
// The setup-code file goes to WATCHPOST_DATA_DIR: a scratch folder, never the app's ./data.
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
  dataDir = mkdtempSync(join(tmpBase, "wp-setup-action-"));
  vi.stubEnv("WATCHPOST_DATA_DIR", dataDir);
  vi.stubEnv("WATCHPOST_MODE", "selfhost");
  h.jar.clear();
  h.headers = new Headers({ "x-real-ip": "10.1.1.1", "user-agent": "test-browser" });
  for (const t of ["members", "local_users", "settings", "rate_limits"]) await db.execute(sql.raw(`delete from ops.${t}`));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

async function printedCode(): Promise<string> {
  let line = "";
  await ensureSetupCode({ key: Buffer.from(KEY_B64, "base64"), siteUrl: "http://127.0.0.1:3100", log: (l) => (line = l) });
  return /code: (\S+)/.exec(line)![1];
}

const form = (code: string, email = "Owner@Example.com") => {
  const fd = new FormData();
  fd.set("code", code);
  fd.set("email", email);
  fd.set("password", "correct horse battery");
  fd.set("confirm", "correct horse battery");
  return fd;
};
const submit = (fd: FormData) => submitSetup({ status: "idle" }, fd);

describe("submitSetup", () => {
  it("creates the owner, signs them in at aal1 and sends them to MFA setup", async () => {
    const code = await printedCode();
    await expect(submit(form(code))).rejects.toThrow("REDIRECT /mfa/setup");
    const [user] = await db.select().from(localUsers);
    expect(user.email).toBe("owner@example.com");
    const cookie = h.jar.get("wp_session")!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(await readLocalSession(cookie.value)).toEqual({ userId: user.id, email: "owner@example.com", aal: "aal1", mustChangePassword: false });
    const [row] = await db.select().from(localSessions).where(eq(localSessions.tokenHash, hashToken(cookie.value)));
    expect(row.userAgent).toBe("test-browser");
    // The setup-code file went with the code.
    expect(existsSync(join(dataDir, "setup-code"))).toBe(false);
  });

  it("revokes a session the browser already carried before signing the owner in", async () => {
    const code = await printedCode();
    const [other] = await db.insert(localUsers).values({ email: "old@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" }).returning({ id: localUsers.id });
    const { token: old } = await createLocalSession(other.id, { aal: "aal2" });
    h.jar.set("wp_session", { value: old });
    await expect(submit(form(code))).rejects.toThrow("REDIRECT /mfa/setup");
    expect(await readLocalSession(old)).toBeNull();
    expect(h.jar.get("wp_session")!.value).not.toBe(old);
  });

  it("refuses once an owner exists and sets no cookie", async () => {
    const code = await printedCode();
    await db.insert(members).values({ userId: crypto.randomUUID(), email: "o@example.com", role: "owner" });
    expect(await submit(form(code))).toMatchObject({ status: "error", message: "This console already has an owner. Sign in instead." });
    expect(h.jar.has("wp_session")).toBe(false);
  });

  it("returns a wrong code's error with the typed code and email, never the password", async () => {
    await printedCode();
    const res = await submit(form("AAAAA-AAAAA", "me@example.com"));
    expect(res).toMatchObject({ status: "error", field: "code", code: "AAAAA-AAAAA", email: "me@example.com" });
    expect(JSON.stringify(res)).not.toContain("correct horse");
    expect(h.jar.has("wp_session")).toBe(false);
  });

  it("keys failed attempts per IP only behind a trusted proxy; x-real-ip and a bare install key nothing per IP", async () => {
    await printedCode();
    const prefixes = async () => (await db.select().from(schema.rateLimits)).map((r) => r.key.split(":")[0]).sort();
    await submit(form("AAAAA-AAAAA"));
    expect(await prefixes()).toEqual(["setup-all"]);
    vi.stubEnv("WATCHPOST_TRUSTED_PROXY_HOPS", "1");
    h.headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    await submit(form("AAAAA-AAAAA"));
    expect(await prefixes()).toEqual(["setup-all", "setup-ip"]);
  });

  it("does not exist outside self-host", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    await expect(submit(form("AAAAA-AAAAA"))).rejects.toThrow("NOT_FOUND");
    expect(await db.select().from(localUsers)).toHaveLength(0);
  });
});

describe("/setup page", () => {
  it("renders the form while no owner exists", async () => {
    await expect(SetupPage()).resolves.toBeTruthy();
  });
  it("is a 404 once an owner exists", async () => {
    await db.insert(members).values({ userId: crypto.randomUUID(), email: "o@example.com", role: "owner" });
    await expect(SetupPage()).rejects.toThrow("NOT_FOUND");
  });
  it("is a 404 in cloud", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    await expect(SetupPage()).rejects.toThrow("NOT_FOUND");
  });
});
