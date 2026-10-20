import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localUsers } from "@/db/schema";
import { demoCookieKey, signDemoCookie } from "@/lib/demo/cookie";
import { demoUserId } from "@/lib/demo/seed/members";
import { AuthError } from "./action";

const DEMO_KEY_B64 = Buffer.alloc(32, 2).toString("base64");
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: DEMO_KEY_B64 }) }));

const s = vi.hoisted(() => ({
  jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  localSession: null as { userId: string; email: string; aal: "aal1" | "aal2"; mustChangePassword?: boolean } | null,
  localUser: [{ confirmedAt: null }] as { confirmedAt: Date | null }[],
  role: "viewer",
  getClaims: vi.fn(),
  supabaseSignOut: vi.fn(),
  readLocalSession: vi.fn(),
  revokeLocalSession: vi.fn(),
  revokeAllLocalSessions: vi.fn(),
  localSessionUserId: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (s.jar.has(name) ? { name, value: s.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => s.jar.set(name, { value, options }),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: s.getClaims,
      mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
      signOut: s.supabaseSignOut,
    },
  }),
}));

vi.mock("@/lib/local-auth/sessions-db", () => ({
  readLocalSession: s.readLocalSession,
  revokeLocalSession: s.revokeLocalSession,
  revokeAllLocalSessions: s.revokeAllLocalSessions,
  localSessionUserId: s.localSessionUserId,
}));

vi.mock("@/db/client", () => ({
  db: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === localUsers ? s.localUser : [{ id: "m1", userId: "u1", email: "a@example.com", role: s.role }]),
        }),
      }),
    }),
  }),
}));

import { getSessionUser, requireActionMember } from "./auth";
import { authProvider, demoProvider, localProvider, supabaseProvider } from "./auth-provider";

const TOKEN = "t".repeat(43);

beforeEach(() => {
  s.jar.clear();
  s.localSession = { userId: "u1", email: "a@example.com", aal: "aal1" };
  s.localUser = [{ confirmedAt: null }];
  s.role = "viewer";
  for (const f of [s.getClaims, s.supabaseSignOut, s.readLocalSession, s.revokeLocalSession, s.revokeAllLocalSessions, s.localSessionUserId]) f.mockReset();
  s.getClaims.mockResolvedValue({ data: { claims: { sub: "u1", email: "A@example.com", aal: "aal1" } } });
  s.readLocalSession.mockImplementation(async () => s.localSession);
  s.localSessionUserId.mockImplementation(async () => s.localSession?.userId ?? null);
});
afterEach(() => vi.unstubAllEnvs());

describe("authProvider()", () => {
  it("is Supabase in cloud, the demo cookie in demo, local in self-host", () => {
    expect(authProvider()).toBe(supabaseProvider);
    vi.stubEnv("WATCHPOST_MODE", "cloud");
    expect(authProvider()).toBe(supabaseProvider);
    vi.stubEnv("WATCHPOST_MODE", "demo");
    expect(authProvider()).toBe(demoProvider);
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(authProvider()).toBe(localProvider);
  });
});

describe("demo (the signed wp_demo cookie)", () => {
  beforeEach(() => vi.stubEnv("WATCHPOST_MODE", "demo"));
  const SEED = "0123456789abcdef0123456789abcdef";
  const demoCookie = (email = "ana@visitor.test") => signDemoCookie({ email, seed: SEED }, demoCookieKey(DEMO_KEY_B64));

  it("a valid cookie is an aal2 session of the seeded owner's user id, with a factor and no password to change", async () => {
    s.jar.set("wp_demo", { value: demoCookie() });
    expect(await getSessionUser()).toEqual({ userId: demoUserId(SEED), email: "ana@visitor.test", aal: "aal2", mustChangePassword: false });
    expect(await authProvider().hasVerifiedFactor(demoUserId(SEED))).toBe(true);
    // The seeded member is an owner and the session aal2: every action gate passes (the db mock answers that member).
    s.role = "owner";
    await expect(requireActionMember("owner")).resolves.toMatchObject({ role: "owner" });
  });

  it("no cookie, or a tampered one, is signed out", async () => {
    expect(await getSessionUser()).toBeNull();
    const [payload, mac] = demoCookie().split(".");
    const other = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace("ana@", "bob@")).toString("base64url");
    s.jar.set("wp_demo", { value: `${other}.${mac}` });
    expect(await getSessionUser()).toBeNull();
    await expect(requireActionMember("viewer")).rejects.toEqual(new AuthError("signed-out"));
  });

  it("signOut clears the wp_demo cookie, whatever the scope, and never reaches Supabase or the local session table", async () => {
    for (const scope of [undefined, "local", "global"] as const) {
      s.jar.set("wp_demo", { value: demoCookie() });
      s.jar.set("wp_session", { value: TOKEN });
      await authProvider().signOut(scope);
      expect(s.jar.get("wp_demo")).toEqual({ value: "", options: expect.objectContaining({ maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" }) });
    }
    expect(s.getClaims).not.toHaveBeenCalled();
    expect(s.supabaseSignOut).not.toHaveBeenCalled();
    expect(s.readLocalSession).not.toHaveBeenCalled();
    expect(s.revokeLocalSession).not.toHaveBeenCalled();
    expect(s.revokeAllLocalSessions).not.toHaveBeenCalled();
  });
});

describe("cloud (WATCHPOST_MODE unset)", () => {
  it("getSessionUser asks Supabase and never the local session table", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    expect(await getSessionUser()).toEqual({ userId: "u1", email: "a@example.com", aal: "aal1" });
    expect(s.getClaims).toHaveBeenCalledTimes(1);
    expect(s.readLocalSession).not.toHaveBeenCalled();
  });

  it("signOut keeps Supabase's own default scope, and passes an explicit one through", async () => {
    await supabaseProvider.signOut();
    expect(s.supabaseSignOut).toHaveBeenLastCalledWith();
    await supabaseProvider.signOut("local");
    expect(s.supabaseSignOut).toHaveBeenLastCalledWith({ scope: "local" });
  });
});

describe("self-host", () => {
  beforeEach(() => vi.stubEnv("WATCHPOST_MODE", "selfhost"));

  it("getSessionUser reads the wp_session cookie's session, never Supabase", async () => {
    expect(await getSessionUser()).toBeNull();
    expect(s.readLocalSession).not.toHaveBeenCalled();
    s.jar.set("wp_session", { value: TOKEN });
    expect(await getSessionUser()).toEqual({ userId: "u1", email: "a@example.com", aal: "aal1" });
    expect(s.readLocalSession).toHaveBeenCalledWith(TOKEN);
    s.localSession = null;
    expect(await getSessionUser()).toBeNull();
    expect(s.getClaims).not.toHaveBeenCalled();
  });

  it("applies the MFA rule with the session's aal and the user's confirmed factor", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ role: "viewer" });
    s.localUser = [{ confirmedAt: new Date() }];
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "mfa" });
    s.role = "owner";
    s.localUser = [{ confirmedAt: null }];
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "mfa" });
    s.localSession = { userId: "u1", email: "a@example.com", aal: "aal2" };
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ role: "owner" });
  });

  it("treats a missing local user as signed out", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    s.localUser = [];
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "signed-out" });
    s.jar.clear();
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "signed-out" });
  });

  it("signOut (default, like Supabase: global) revokes every session of the user and clears the cookie", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    await localProvider.signOut();
    expect(s.revokeAllLocalSessions).toHaveBeenCalledWith("u1");
    expect(s.revokeLocalSession).toHaveBeenCalledWith(TOKEN);
    expect(s.jar.get("wp_session")).toMatchObject({ value: "", options: { maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" } });
    expect(s.supabaseSignOut).not.toHaveBeenCalled();
  });

  it("signOut (global) still reaches the other devices when this browser's own session has already ended", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    s.readLocalSession.mockResolvedValue(null);
    s.localSessionUserId.mockResolvedValue("u1");
    await localProvider.signOut();
    expect(s.localSessionUserId).toHaveBeenCalledWith(TOKEN);
    expect(s.revokeAllLocalSessions).toHaveBeenCalledWith("u1");
    expect(s.jar.get("wp_session")?.value).toBe("");
  });

  it("a session whose password must change gets only the password page: actions refuse with password-change", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    s.localSession = { userId: "u1", email: "a@example.com", aal: "aal1", mustChangePassword: true };
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "password-change" });
    s.localSession = { ...s.localSession, mustChangePassword: false };
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ role: "viewer" });
  });

  it("signOut('local') revokes only this session; without a cookie it just clears", async () => {
    s.jar.set("wp_session", { value: TOKEN });
    await localProvider.signOut("local");
    expect(s.revokeLocalSession).toHaveBeenCalledWith(TOKEN);
    expect(s.revokeAllLocalSessions).not.toHaveBeenCalled();
    s.jar.clear();
    s.revokeLocalSession.mockClear();
    await localProvider.signOut();
    expect(s.revokeLocalSession).not.toHaveBeenCalled();
    expect(s.jar.get("wp_session")?.value).toBe("");
  });
});
