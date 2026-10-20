import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicPath, safeNext } from "./paths";

describe("isPublicPath", () => {
  it.each(["/signin", "/auth/confirm", "/auth/not-member", "/auth/session-ended", "/api/collect", "/api/watchdog", "/api/daily", "/api/health", "/api/ping/hb_x", "/api/v1/ai/models", "/api/v1/mcp", "/api/v1/status", "/s/acme", "/s/acme/badge/web.svg"])("%s is public", (p) => expect(isPublicPath(p)).toBe(true));
  it.each(["/", "/settings", "/authx", "/invite", "/signin-other", "/api/status", "/api/anything", "/api/pingx", "/api/healthz", "/api/health/x", "/api/ping", "/status", "/sx", "/s", "/s-x", "/settings/s/x", "/api/s/x", "/S/acme", "/api/v1", "/api/v1x", "/api-docs", "/api-docs/status", "/ai", "/ai/keys", "/office", "/office/kantor-virtual.html", "/api/office/state"])("%s needs a session", (p) => expect(isPublicPath(p)).toBe(false));
});

describe("safeNext", () => {
  it("keeps same-site paths with their query", () => {
    expect(safeNext("/settings?tab=users")).toBe("/settings?tab=users");
  });
  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "/..//evil.com", "/.//evil.com", "/%2e%2e//evil.com", "/x/..//evil.com", "javascript:alert(1)", "", null, undefined])(
    "falls back for %s",
    (n) => expect(safeNext(n as string | null | undefined)).toBe("/"),
  );
  it("uses the given fallback", () => {
    expect(safeNext(null, "/invite")).toBe("/invite");
  });
});

describe("isPublicPath /setup", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is public only in self-host (first-run setup)", () => {
    expect(isPublicPath("/setup")).toBe(false);
    vi.stubEnv("WATCHPOST_MODE", "demo");
    expect(isPublicPath("/setup")).toBe(false);
    expect(isPublicPath("/signin")).toBe(true);
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    expect(isPublicPath("/setup")).toBe(true);
    for (const p of ["/setup/x", "/setupx", "/Setup", "/settings"]) expect(isPublicPath(p)).toBe(false);
  });
});
