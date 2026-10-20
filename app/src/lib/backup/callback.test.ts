import { describe, expect, it, vi } from "vitest";
import { open } from "@/lib/crypto";
import { finishDriveConnect } from "./callback";
import { sealTicket } from "./connect";

const key = Buffer.alloc(32, 3).toString("base64");
const env = { clientId: "1234-fake.apps.googleusercontent.com", clientSecret: "fake-client-secret" };
const ticket = { state: "S".repeat(43), verifier: "V".repeat(86), memberId: "mem-1", exp: 2_000 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function deps(answer: Response) {
  const saved: { ciphertext: string; iv: string; keyVersion: number }[] = [];
  const audits: unknown[] = [];
  const fetch = vi.fn<(u: string, i: RequestInit) => Promise<Response>>(async () => answer);
  return {
    saved, audits, fetch,
    d: {
      env, keyB64: key, siteUrl: "https://ops.example.com", now: 1_000, fetch: fetch as unknown as typeof globalThis.fetch,
      save: async (s: { ciphertext: string; iv: string; keyVersion: number }) => { saved.push(s); },
      audit: async (e: unknown) => { audits.push(e); },
    },
  };
}

const params = (over: Partial<{ cookie: string | undefined; state: string | null; code: string | null; error: string | null; memberId: string }> = {}) =>
  ({ cookie: sealTicket(ticket, key), state: ticket.state, code: "4/0fake", error: null, memberId: "mem-1", ...over });

describe("finishDriveConnect", () => {
  it("exchanges the code with the verifier and the fixed callback, stores the refresh token sealed, and audits", async () => {
    const t = deps(json({ access_token: "at", refresh_token: "fake-refresh-token", scope: "https://www.googleapis.com/auth/drive.file" }));
    expect(await finishDriveConnect(params(), t.d)).toBe("connected");
    const form = new URLSearchParams(String(t.fetch.mock.calls[0][1].body));
    expect(form.get("code_verifier")).toBe(ticket.verifier);
    expect(form.get("redirect_uri")).toBe("https://ops.example.com/auth/google/callback");
    expect(t.saved).toHaveLength(1);
    expect(JSON.stringify(t.saved)).not.toContain("fake-refresh-token");
    expect(open(t.saved[0], key)).toBe("fake-refresh-token");
    expect(t.audits).toEqual([{ kind: "ok", message: "Google Drive connected" }]);
  });
  it("never calls Google for a forged or stale answer", async () => {
    for (const [over, code] of [
      [{ state: "X".repeat(43) }, "state"],
      [{ cookie: undefined }, "expired"],
      [{ memberId: "mem-2" }, "member"],
      [{ error: "access_denied", code: null }, "denied"],
    ] as const) {
      const t = deps(json({}));
      expect(await finishDriveConnect(params(over), t.d)).toBe(code);
      expect(t.fetch).not.toHaveBeenCalled();
      expect(t.saved).toEqual([]);
    }
  });
  it("says the env is missing before anything else", async () => {
    const t = deps(json({}));
    expect(await finishDriveConnect(params(), { ...t.d, env: null })).toBe("env");
  });
  it("maps Google's refusals to fixed codes and audits the failure without Google's text", async () => {
    const refused = deps(json({ error: "invalid_grant", error_description: "secret detail" }, 400));
    expect(await finishDriveConnect(params(), refused.d)).toBe("refused");
    expect(JSON.stringify(refused.audits)).not.toContain("secret detail");
    expect(await finishDriveConnect(params(), deps(json({ access_token: "at", scope: "https://www.googleapis.com/auth/drive.file" })).d)).toBe("scope");
    expect(await finishDriveConnect(params(), deps(json({}, 503)).d)).toBe("failed");
  });
});
