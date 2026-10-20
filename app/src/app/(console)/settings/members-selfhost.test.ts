import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { localSessions, localUsers, members } from "@/db/schema";
import { AuthError } from "@/lib/action";
import { hasRole, type Role } from "@/lib/roles";

// Self-host members (plan 3, task 7): Add member creates a local account with a temporary password; Remove deletes it.
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { id: "", userId: "", email: "owner@example.com", role: "owner" as "owner" | "operator" | "viewer" },
  recordAction: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/auth", () => ({
  requireActionMember: async (min: Role) => {
    if (!hasRole(h.actor.role, min)) throw new AuthError("forbidden");
    return h.actor;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/supabase/admin", () => ({ adminClient: () => ({ auth: { admin: { createUser: h.createUser } } }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "http://127.0.0.1:3100" }) }));

import { verifyPassword } from "@/lib/local-auth/password";
import { createLocalSession, readLocalSession } from "@/lib/local-auth/sessions-db";
import { passwordSignIn } from "@/lib/local-auth/signin";
import { addMember, inviteUser, removeMember } from "./actions";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

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
  vi.stubEnv("WATCHPOST_MODE", "selfhost");
  h.recordAction.mockReset().mockResolvedValue(undefined);
  h.createUser.mockReset();
  for (const t of ["members", "local_users", "rate_limits"]) await db.execute(sql.raw(`delete from ops.${t}`));
  const [owner] = await db.insert(localUsers).values({ email: "owner@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" }).returning({ id: localUsers.id });
  const [m] = await db.insert(members).values({ userId: owner.id, email: "owner@example.com", role: "owner" }).returning({ id: members.id });
  h.actor = { id: m.id, userId: owner.id, email: "owner@example.com", role: "owner" };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const add = (email: string, role = "viewer") => addMember(null, form({ email, role }));
const accountOf = async (email: string) => (await db.select().from(localUsers).where(eq(localUsers.email, email)))[0];

describe("addMember (self-host)", () => {
  it("creates the account and membership, returns the temporary password once and stores only its hash", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = Date.now();
    const r = await add("  Ana@Example.COM ", "operator");
    expect(r).toMatchObject({ ok: true, message: "ana@example.com was added.", data: { email: "ana@example.com" } });
    const password = r.ok ? r.data!.password : "";
    expect(password).toMatch(/^[a-km-np-z2-9]{20}$/);

    const account = await accountOf("ana@example.com");
    expect(account.mustChangePassword).toBe(true);
    // The temporary password works for 7 days.
    const expiry = account.tempPasswordExpiresAt!.getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    expect(account.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(password, account.passwordHash)).toBe(true);
    const [member] = await db.select().from(members).where(eq(members.userId, account.id));
    expect(member).toMatchObject({ email: "ana@example.com", role: "operator", invitedBy: h.actor.id });

    // Nowhere in the database, the audit entry or the server log.
    const everything = JSON.stringify([await db.select().from(localUsers), await db.select().from(members)]);
    expect(everything).not.toContain(password);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Added ana@example.com as operator", resourceId: null, actorUserId: h.actor.userId });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain(password);
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(password);
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it("gives every member a different temporary password", async () => {
    const a = await add("a@example.com");
    const b = await add("b@example.com");
    expect(a.ok && b.ok && a.data!.password !== b.data!.password).toBe(true);
  });

  it("refuses an existing member or account, a bad email, and a missing role", async () => {
    expect(await add("owner@example.com")).toMatchObject({ ok: false, fieldErrors: { email: "That person is already a member." } });
    await db.insert(localUsers).values({ email: "orphan@example.com", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==" });
    expect(await add("ORPHAN@example.com")).toMatchObject({ ok: false, fieldErrors: { email: "That person is already a member." } });
    expect(await add("not an email")).toMatchObject({ ok: false, fieldErrors: { email: "Enter a valid email address." } });
    expect(await addMember(null, form({ email: "c@example.com", role: "admin" }))).toMatchObject({ ok: false, fieldErrors: { role: "Pick a role." } });
    expect(await db.select().from(members)).toHaveLength(1);
  });

  it("is Owner only: an operator or viewer can't add members", async () => {
    for (const role of ["operator", "viewer"] as const) {
      h.actor = { ...h.actor, role };
      expect(await add("eve@example.com", "owner")).toEqual({ ok: false, error: "You don't have permission to do that." });
    }
    expect(await accountOf("eve@example.com")).toBeUndefined();
  });

  it("the demo refuses both invites and added members, without Supabase or a new account", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    // Refused by runGuarded's demo policy (lib/demo/simulate.ts) before the action runs.
    expect(await add("ana@example.com")).toEqual({ ok: false, error: "Not available in the demo" });
    expect(await inviteUser(null, form({ email: "ana@example.com", role: "viewer" }))).toEqual({ ok: false, error: "Not available in the demo" });
    expect(h.createUser).not.toHaveBeenCalled();
    expect(await accountOf("ana@example.com")).toBeUndefined();
  });

  it("is refused in cloud mode, and the cloud invite is refused in self-host", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    expect(await add("ana@example.com")).toEqual({ ok: false, error: "Use Invite user on this console." });
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(await inviteUser(null, form({ email: "ana@example.com", role: "viewer" }))).toEqual({ ok: false, error: "Use Add member on this console." });
    expect(h.createUser).not.toHaveBeenCalled();
    expect(await accountOf("ana@example.com")).toBeUndefined();
  });

  it("first sign-in with the temporary password goes to the forced password change", async () => {
    const r = await add("ana@example.com", "viewer");
    const signedIn = await passwordSignIn({ email: "ana@example.com", password: r.ok ? r.data!.password : "", ip: null, userAgent: "t", presentedToken: undefined });
    expect(signedIn).toMatchObject({ ok: true, redirectTo: "/account/password" });
  });
});

describe("removeMember (self-host)", () => {
  it("deletes the membership and the account, which ends every session of theirs", async () => {
    await add("ana@example.com");
    const account = await accountOf("ana@example.com");
    const [member] = await db.select().from(members).where(eq(members.userId, account.id));
    const { token: one } = await createLocalSession(account.id, { aal: "aal1" });
    const { token: two } = await createLocalSession(account.id, { aal: "aal2" });

    expect(await removeMember(member.id)).toEqual({ ok: true, message: "ana@example.com can't use the console anymore. Their account and sessions are deleted." });
    expect(await accountOf("ana@example.com")).toBeUndefined();
    expect(await db.select().from(members).where(eq(members.id, member.id))).toHaveLength(0);
    expect(await db.select().from(localSessions).where(eq(localSessions.userId, account.id))).toHaveLength(0);
    expect(await readLocalSession(one)).toBeNull();
    expect(await readLocalSession(two)).toBeNull();
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Removed ana@example.com from the console and deleted their account" }));
  });

  it("refuses removing yourself, and keeps your account", async () => {
    expect(await removeMember(h.actor.id)).toEqual({ ok: false, error: "You can't remove yourself. Ask another owner." });
    expect(await accountOf("owner@example.com")).toBeDefined();
  });

  it("refuses removing the last owner, and changes nothing", async () => {
    // The actor was demoted meanwhile: h.actor still says owner (so the role gate lets the call through), but its member
    // row is an operator now, which leaves boss as the only owner row.
    await add("boss@example.com", "owner");
    const boss = await accountOf("boss@example.com");
    const [bossMember] = await db.select().from(members).where(eq(members.userId, boss.id));
    await db.update(members).set({ role: "operator" }).where(eq(members.id, h.actor.id));
    expect(await removeMember(bossMember.id)).toEqual({ ok: false, error: "The console needs at least one owner. Make someone else an owner first." });
    expect(await accountOf("boss@example.com")).toBeDefined();
  });
});
