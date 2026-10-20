import { describe, expect, it } from "vitest";
import { apiError, apiJson } from "./respond";

describe("apiError", () => {
  it("answers OpenAI-style, keeps the given headers and is never cached", async () => {
    const res = apiError("key_rate_limit", "Slow down.", 429, { "Retry-After": "12" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: { type: "key_rate_limit", message: "Slow down." } });
  });

  it("does not let a caller's header replace no-store", () => {
    expect(apiError("invalid_api_key", "No key.", 401, { "Cache-Control": "public" }).headers.get("cache-control")).toBe("no-store");
  });
});

describe("apiJson", () => {
  it("sends JSON with no-store and the given status", async () => {
    const res = apiJson({ ok: true }, { status: 201, headers: { "X-Test": "1" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("defaults to 200", () => {
    expect(apiJson([]).status).toBe(200);
  });
});
