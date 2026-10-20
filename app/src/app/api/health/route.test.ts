import { describe, expect, it } from "vitest";
import { GET, HEAD } from "./route";

describe("GET /api/health", () => {
  it("answers ok, uncached, without any dependency", async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, service: "watchbell" });
  });
  it("answers HEAD with 200 and no body", async () => {
    const r = await HEAD();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
});
