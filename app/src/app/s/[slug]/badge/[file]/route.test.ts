import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ publicBadge: vi.fn() }));
vi.mock("@/lib/data/public-status-db", () => ({ publicBadge: h.publicBadge }));

import * as route from "./route";

const call = (slug: string, file: string) => route.GET(new Request(`https://ops.example.com/s/${slug}/badge/${file}`), { params: Promise.resolve({ slug, file }) });

beforeEach(() => {
  h.publicBadge.mockReset();
  h.publicBadge.mockResolvedValue({ label: "uptime", value: "99.98%", tone: "ok" });
});

describe("GET /s/{slug}/badge/{key}.svg (U7)", () => {
  it("is static and cached for 5 minutes", async () => {
    expect(route.revalidate).toBe(300);
    expect(route.dynamic).toBe("force-static");
    expect(await route.generateStaticParams()).toEqual([]);
  });

  it("draws the monitor's badge as an SVG that can't be sniffed", async () => {
    const res = await call("acme", "wedding-site.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    const body = await res.text();
    expect(body).toContain(">99.98%<");
    expect(h.publicBadge).toHaveBeenCalledWith("acme", "wedding-site", expect.any(Date));
  });

  it("answers a grey not-found badge for an unknown page or key", async () => {
    h.publicBadge.mockResolvedValue(null);
    const res = await call("acme", "nope.svg");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(">not found<");
  });

  it("never asks the database about a malformed slug or file", async () => {
    for (const [slug, file] of [["Acme", "web.svg"], ["../x", "web.svg"], ["acme", "web.png"], ["acme", "../web.svg"], ["acme", "WEB.svg"], ["acme", ".svg"], ["acme", `${"a".repeat(41)}.svg`]]) {
      expect((await call(slug, file)).status).toBe(404);
    }
    expect(h.publicBadge).not.toHaveBeenCalled();
  });
});
