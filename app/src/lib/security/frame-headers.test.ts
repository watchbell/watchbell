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
      expect(h.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    });
  });

  it("the office HTML may be framed by the console itself, nobody else", async () => {
    const h = await effective("/office/kantor-virtual.html", true);
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("without the office HTML (the open source edition) no path gets the same-origin exception", async () => {
    const h = await effective("/office/kantor-virtual.html", false);
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });
});
