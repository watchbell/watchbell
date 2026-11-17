import { describe, expect, it, vi } from "vitest";
import { ALL_WORKSPACES, pickWorkspace, switcherEntries, workspaceLabel } from "./choice";
import { wsCookieOptions } from "./choice";

const P = { id: "00000000-0000-4000-8000-00000000f001", name: "Personal" };
const K = { id: "00000000-0000-4000-8000-0000000000b1", name: "Kopi Senja" };

// Watchbell 1.8 (spec §5; Review Focus 3).
describe("pickWorkspace", () => {
  it("takes the cookie's workspace, falls back to the first for an unknown or deleted one, and none when unset", () => {
    expect(pickWorkspace(K.id, [P, K])).toBe(K.id);
    expect(pickWorkspace("00000000-0000-4000-8000-0000000000ff", [P, K])).toBe(P.id);
    expect(pickWorkspace("garbage", [P, K])).toBe(P.id);
    expect(pickWorkspace(undefined, [P, K])).toBe(P.id);
  });

  it("All workspaces is null, and means the only one when there is one", () => {
    expect(pickWorkspace(ALL_WORKSPACES, [P, K])).toBeNull();
    expect(pickWorkspace(ALL_WORKSPACES, [P])).toBe(P.id);
  });
});

describe("switcherEntries", () => {
  it("checks the current workspace and adds All workspaces when there are several", () => {
    expect(switcherEntries([P, K], K.id)).toEqual([
      { value: P.id, label: "Personal", checked: false },
      { value: K.id, label: "Kopi Senja", checked: true },
      { value: "all", label: "All workspaces", checked: false },
    ]);
    expect(switcherEntries([P], P.id)).toEqual([{ value: P.id, label: "Personal", checked: true }]);
    expect(workspaceLabel([P, K], null)).toBe("All workspaces");
    expect(workspaceLabel([P, K], K.id)).toBe("Kopi Senja");
  });
});

// 1.8.3: the workspace cookie was Secure by NODE_ENV (the switcher) or by the request's own scheme (the palette link),
// so a self-hosted console opened over plain http on the LAN dropped it, and one behind a TLS proxy set it without
// Secure. It now follows the session cookie: Secure exactly when SITE_URL is https.
describe("wsCookieOptions (1.8.3)", () => {
  it("is Secure when the console's address is https, and not over plain http", () => {
    expect(wsCookieOptions("https://ops.example.com")).toEqual({ path: "/", sameSite: "lax", httpOnly: true, maxAge: 31_536_000, secure: true });
    expect(wsCookieOptions("http://192.168.1.20:3100").secure).toBe(false);
    expect(wsCookieOptions("http://localhost:3100").secure).toBe(false);
    expect(wsCookieOptions(undefined).secure).toBe(false);
  });
});

// Final review 1.8.3 M3: on Vercel the cookie was always Secure (by NODE_ENV); a cloud deploy with an http SITE_URL
// keeps it Secure (Vercel serves https only).
describe("wsCookieOptions on Vercel (1.8.3)", () => {
  it("stays Secure on Vercel whatever SITE_URL says", () => {
    vi.stubEnv("VERCEL", "1");
    expect(wsCookieOptions("http://ops.example.com").secure).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv("VERCEL", "");
    expect(wsCookieOptions("http://ops.example.com").secure).toBe(false);
    vi.unstubAllEnvs();
  });
});
