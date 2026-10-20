import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localUsers, members } from "@/db/schema";
import { AuthError, runGuarded } from "@/lib/action";

// Self-host: a temporary password (must_change_password) is good for /account/password only. The gates hold the member
// there until it is changed, after the MFA step.
const OLD = "temporary-password-1";
const NEW = "my own password 42";
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  jar: new Map<string, { value: string; options?: unknown }>(),
}));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "test-browser" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => void h.jar.set(name, { value, options }),
  }),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { requireActionMember, requirePageMember } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/local-auth/password";
import { createLocalSession, readLocalSession } from "@/lib/local-auth/sessions-db";
import { changePassword, type PasswordFormState } from "./actions";
import AccountPasswordPage from "./page";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let oldHash: string;
let userId: string;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  oldHash = await hashPassword(OLD);
}, 120_000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  vi.stubEnv("WATCHPOST_MODE", "selfhost");
  h.jar.clear();
  for (const t of ["members", "local_users", "rate_limits"]) await db.execute(sql.raw(`delete from ops.${t}`));
  [{ id: userId }] = await db.insert(localUsers).values({ email: "ana@example.com", passwordHash: oldHash, mustChangePassword: true }).returning({ id: localUsers.id });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function signedIn(role: "owner" | "operator" | "viewer", aal: "aal1" | "aal2", opts: { factor?: boolean } = {}) {
  await db.insert(members).values({ userId, email: "ana@example.com", role });
  if (opts.factor) await db.update(localUsers).set({ totpConfirmedAt: new Date(), totpSecretSealed: "v1:x:y" }).where(eq(localUsers.id, userId));
  const { token } = await createLocalSession(userId, { aal });
  h.jar.set("wp_session", { value: token });
  return token;
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const IDLE: PasswordFormState = { status: "idle" };
const submit = (over: Record<string, string> = {}) => changePassword(IDLE, form({ current: OLD, password: NEW, confirm: NEW, ...over }));
const guarded = () => runGuarded("viewer", async () => ({ ok: true }), { requireActionMember });

describe("gates while the temporary password is unchanged", () => {
  it("pages go to /account/password and actions are refused, for a viewer without MFA", async () => {
    await signedIn("viewer", "aal1");
    await expect(requirePageMember()).rejects.toThrow("REDIRECT /account/password");
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "password-change" });
    expect(await guarded()).toEqual({ ok: false, error: "Change your temporary password first." });
  });

  it("the MFA step comes first, then the password change", async () => {
    await signedIn("owner", "aal1");
    await expect(requirePageMember()).rejects.toThrow("REDIRECT /mfa/setup");
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ reason: "mfa" });
    await db.update(members).set({ role: "viewer" });
    await db.update(localUsers).set({ totpConfirmedAt: new Date() });
    await expect(requirePageMember()).rejects.toThrow("REDIRECT /mfa");
  });

  it("an aal2 owner is still held at /account/password", async () => {
    await signedIn("owner", "aal2", { factor: true });
    await expect(requirePageMember()).rejects.toThrow("REDIRECT /account/password");
    await expect(requireActionMember("owner")).rejects.toMatchObject({ reason: "password-change" });
  });

  it("without the flag, nothing changes for anyone", async () => {
    await db.update(localUsers).set({ mustChangePassword: false });
    await signedIn("viewer", "aal1");
    await expect(requirePageMember()).resolves.toMatchObject({ userId, role: "viewer" });
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ userId });
  });
});

describe("changePassword", () => {
  it("replaces the password, clears the flag, rotates this session, ends the others, and lets the member in", async () => {
    const current = await signedIn("owner", "aal2", { factor: true });
    const { token: otherDevice } = await createLocalSession(userId, { aal: "aal2" });

    await expect(submit()).rejects.toThrow("REDIRECT /");
    const fresh = h.jar.get("wp_session")!;
    expect(fresh.value).not.toBe(current);
    expect(fresh.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(await readLocalSession(fresh.value)).toMatchObject({ userId, aal: "aal2" });
    expect(await readLocalSession(current)).toBeNull();
    expect(await readLocalSession(otherDevice)).toBeNull();

    const [row] = await db.select().from(localUsers).where(eq(localUsers.id, userId));
    expect(row.mustChangePassword).toBe(false);
    expect(await verifyPassword(NEW, row.passwordHash)).toBe(true);
    await expect(requirePageMember()).resolves.toMatchObject({ userId });
    await expect(requireActionMember("owner")).resolves.toMatchObject({ userId });
  });

  it("returns the problem for a wrong current password and keeps the session", async () => {
    const current = await signedIn("viewer", "aal1");
    expect(await submit({ current: "not the password" })).toEqual({ status: "error", message: "That isn't your current password.", field: "current" });
    expect(h.jar.get("wp_session")!.value).toBe(current);
    expect((await db.select().from(localUsers))[0].mustChangePassword).toBe(true);
  });

  it("needs the MFA step first: a password-only session can't change the password", async () => {
    await signedIn("viewer", "aal1", { factor: true });
    await expect(submit()).rejects.toThrow("REDIRECT /mfa");
    expect((await db.select().from(localUsers))[0].passwordHash).toBe(oldHash);
  });

  it("without a session goes to /signin", async () => {
    await expect(submit()).rejects.toThrow("REDIRECT /signin");
  });

  it("doesn't exist in the cloud", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    await expect(submit()).rejects.toThrow("NOT_FOUND");
    await expect(AccountPasswordPage()).rejects.toThrow("NOT_FOUND");
  });
});
