import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ logo: null as Uint8Array | null }));
vi.mock("@/lib/data/branding-db", () => ({ readBrandLogo: async () => h.logo }));

import { logoVersionOf } from "@/lib/branding-version";
import { GET } from "./route";

const get = (q = "") => GET(new Request(`http://x/brand-icon${q}`));

// Watchbell 1.7: the brand's logo for the sign-in page, the sidebar, the browser tab and the public status page.
describe("GET /brand-icon", () => {
  it("serves the stored PNG", async () => {
    h.logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(h.logo);
  });
  it("is 404 without a logo", async () => {
    h.logo = null;
    expect((await get()).status).toBe(404);
  });
});

// Review M-9 (1.7.1): a versioned address is cached at the CDN for good (a new logo has a new address); one without a
// version (an old cached page) only for 5 minutes, so it shows a new logo soon.
describe("GET /brand-icon caching (1.7.1)", () => {
  it("caches a versioned address for good and an unversioned one briefly", async () => {
    h.logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    expect((await get(`?v=${logoVersionOf(h.logo)}`)).headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=31536000, immutable");
    // Final review: a version that isn't this logo's (an old page, or the moment a new logo is saved) is never kept long,
    // or going back to that logo later would show this one for a year.
    expect((await get("?v=0123456789ab")).headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect((await get()).headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect((await get("?v=nope")).headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
  });
});
