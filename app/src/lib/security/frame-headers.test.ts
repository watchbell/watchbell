import { afterEach, describe, expect, it, vi } from "vitest";

// The console refuses every frame, except the Kantor Virtual HTML (private edition only), which the console frames itself
// (same origin only). next.config.ts adds that exception only when public/office/kantor-virtual.html exists, so the open
// source edition (no office) frames nothing at all.
const office = vi.hoisted(() => ({ present: true }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]) =>
    String(p).replace(/\\/g, "/").endsWith("public/office/kantor-virtual.html") ? office.present : actual.existsSync(p);
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

// Next applies every matching entry in order; for the same key the last one wins.
async function effective(path: string, withOffice: boolean) {
  office.present = withOffice;
  vi.resetModules();
  const config = (await import("../../../next.config")).default;
  const out = new Map<string, string>();
  for (const rule of (await config.headers?.()) ?? []) {
    const re = new RegExp(`^${rule.source.replace(/\./g, "\\.").replace(/\/:path\*$/, "(?:/.*)?")}$`);
    if (re.test(path)) for (const h of rule.headers) out.set(h.key, h.value);
  }
  return out;
}

describe("frame headers (next.config.ts)", () => {
  afterEach(() => {
    office.present = true;
  });

  describe.each([true, false])("with the office HTML present: %s", (withOffice) => {
    it.each(["/", "/office", "/api/office/state", "/settings", "/office/other.html"])("%s may not be framed at all", async (p) => {
      const h = await effective(p, withOffice);
      expect(h.get("X-Frame-Options")).toBe("DENY");
      expect(h.get("Content-Security-Policy")).toBeUndefined(); // the proxy's enforced CSP carries frame-ancestors (1.2.1)
    });
  });

  it("the office HTML may be framed by the console itself, nobody else", async () => {
    const h = await effective("/office/kantor-virtual.html", true);
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("Content-Security-Policy")).toBeUndefined();
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("without the office HTML (the open source edition) no path gets the same-origin exception", async () => {
    const h = await effective("/office/kantor-virtual.html", false);
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Content-Security-Policy")).toBeUndefined(); // the proxy's enforced CSP carries frame-ancestors (1.2.1)
  });

  // Watchbell 1.2.1 (audit hardening list 3): no X-Powered-By, no powerful browser features, a separate browsing context.
  it.each(["/", "/s/acme", "/api/v1/me", "/office/kantor-virtual.html"])("%s gets Permissions-Policy and COOP", async (p) => {
    const h = await effective(p, true);
    expect(h.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("doesn't send X-Powered-By", async () => {
    vi.resetModules();
    expect((await import("../../../next.config")).default.poweredByHeader).toBe(false);
  });
});
