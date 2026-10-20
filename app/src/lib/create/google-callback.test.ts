import { describe, expect, it, vi } from "vitest";
import { sealTicket } from "@/lib/backup/connect";
import { finishCreateConnect } from "./google-callback";
import { createAuthUrl, GCP_SCOPE } from "./google-connect";

// Stage 6 create requests, Firebase: the Owner's separate Google grant (cloud-platform), guarded like the Drive one.
const KEY = Buffer.alloc(32, 7).toString("base64");
const env = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "sec" };
const ticket = (o: object = {}) => sealTicket({ state: "s1", verifier: "v".repeat(50), memberId: "m1", exp: 2_000_000, ...o }, KEY);
const tokenFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Connect Google (create projects)", () => {
  it("asks for cloud-platform only, offline, with PKCE, at its own callback", () => {
    const u = new URL(createAuthUrl(env, { state: "s1", challenge: "c1", redirectUri: "https://w.example.com/auth/google/create/callback" }));
    expect(u.searchParams.get("scope")).toBe(GCP_SCOPE);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://w.example.com/auth/google/create/callback");
  });
  const base = { cookie: ticket(), state: "s1", code: "c", error: null, memberId: "m1" };
  const deps = (f: typeof fetch, save = vi.fn(async () => undefined)) => ({ env, keyB64: KEY, siteUrl: "https://w.example.com", save, audit: vi.fn(async () => undefined), fetch: f, now: 1_000_000 });

  it("seals and saves the refresh token only when cloud-platform was granted", async () => {
    const save = vi.fn(async () => undefined);
    expect(await finishCreateConnect(base, deps(tokenFetch({ refresh_token: "1//rt", scope: GCP_SCOPE }), save))).toBe("connected");
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(save.mock.calls)).not.toContain("1//rt");
    const save2 = vi.fn(async () => undefined);
    expect(await finishCreateConnect(base, deps(tokenFetch({ refresh_token: "1//rt", scope: "openid" }), save2))).toBe("scope");
    expect(save2).not.toHaveBeenCalled();
  });
  it("refuses another member's ticket, a wrong state, an expired ticket, and a missing env", async () => {
    const f = tokenFetch({});
    expect(await finishCreateConnect({ ...base, memberId: "m2" }, deps(f))).toBe("member");
    expect(await finishCreateConnect({ ...base, state: "other" }, deps(f))).toBe("state");
    expect(await finishCreateConnect({ ...base, cookie: ticket({ exp: 1 }) }, deps(f))).toBe("expired");
    expect(await finishCreateConnect(base, { ...deps(f), env: null })).toBe("env");
    expect(f).not.toHaveBeenCalled();
  });
});
