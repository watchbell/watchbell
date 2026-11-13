import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ logo: null as Uint8Array | null }));
vi.mock("@/lib/data/branding-db", () => ({ readBrandLogo: async () => h.logo }));

import { GET } from "./route";

// Watchbell 1.7: the brand's logo for the sign-in page, the sidebar, the browser tab and the public status page.
describe("GET /brand-icon", () => {
  it("serves the stored PNG, cached briefly", async () => {
    h.logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(h.logo);
  });
  it("is 404 without a logo", async () => {
    h.logo = null;
    expect((await GET()).status).toBe(404);
  });
});
