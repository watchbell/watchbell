import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "./action";

const state = vi.hoisted(() => ({
  claims: { sub: "u1", email: "a@example.com", aal: "aal1" } as Record<string, unknown>,
  role: "viewer" as string,
  factors: { data: { totp: [] as { status: string }[] }, error: null } as { data: { totp: { status: string }[] } | null; error: unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({ data: { claims: state.claims } }),
      mfa: { listFactors: async () => state.factors },
    },
  }),
}));

vi.mock("@/db/client", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "m1", userId: "u1", email: "a@example.com", role: state.role }],
        }),
      }),
    }),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

import { currentMfa, requireActionMember, requirePageMember } from "./auth";

beforeEach(() => {
  state.claims = { sub: "u1", email: "a@example.com", aal: "aal1" };
  state.role = "viewer";
  state.factors = { data: { totp: [] }, error: null };
});

describe("requireActionMember MFA gate", () => {
  it("fails closed when the factor list can't be read, even for a viewer", async () => {
    state.factors = { data: null, error: new Error("getUser failed") };
    await expect(requireActionMember("viewer")).rejects.toThrow("mfa factors unavailable");
    state.factors = { data: null, error: new AuthApiError("upstream down", 503, undefined) };
    await expect(requireActionMember("viewer")).rejects.toThrow("mfa factors unavailable");
  });

  it("treats a session revoked elsewhere (session_not_found) as signed out", async () => {
    state.factors = { data: null, error: new AuthSessionMissingError() };
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "signed-out" });
  });

  it("refuses an aal1 owner who has no factor yet", async () => {
    state.role = "owner";
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "mfa" });
  });

  it("refuses an aal1 viewer who has a verified factor", async () => {
    state.factors = { data: { totp: [{ status: "verified" }] }, error: null };
    await expect(requireActionMember("viewer")).rejects.toMatchObject({ constructor: AuthError, reason: "mfa" });
  });

  it("lets an aal1 viewer without a factor through, and an aal2 session without asking for factors", async () => {
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ role: "viewer" });
    state.role = "owner";
    state.claims = { ...state.claims, aal: "aal2" };
    state.factors = { data: null, error: new Error("unused") };
    await expect(requireActionMember("viewer")).resolves.toMatchObject({ role: "owner" });
  });
});

describe("page gates on a session revoked elsewhere", () => {
  it("send the browser to the route that clears the session cookies", async () => {
    state.factors = { data: null, error: new AuthSessionMissingError() };
    await expect(requirePageMember()).rejects.toThrow("redirect:/auth/session-ended");
    await expect(currentMfa()).rejects.toThrow("redirect:/auth/session-ended");
  });

  it("still fail closed on any other factor error", async () => {
    state.factors = { data: null, error: new Error("getUser failed") };
    await expect(requirePageMember()).rejects.toThrow("mfa factors unavailable");
    await expect(currentMfa()).rejects.toThrow("mfa factors unavailable");
  });
});
