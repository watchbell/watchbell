import { describe, expect, it, vi } from "vitest";
import { RATE_LIMITED, TtlCache } from "./ttl-cache";

describe("TtlCache", () => {
  it("keeps a value for its TTL, then reads again", async () => {
    let t = 0;
    const c = new TtlCache();
    const load = vi.fn(async () => ({ ok: true as const, data: t }));
    expect(await c.get("k", 100, load, () => t)).toEqual({ ok: true, data: 0 });
    t = 50;
    expect(await c.get("k", 100, load, () => t)).toEqual({ ok: true, data: 0 });
    t = 150;
    expect(await c.get("k", 100, load, () => t)).toEqual({ ok: true, data: 150 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep failures", async () => {
    const c = new TtlCache();
    const load = vi.fn(async () => ({ ok: false as const, kind: "transient" as const, error: "down" }));
    await c.get("k", 1000, load, () => 0);
    await c.get("k", 1000, load, () => 1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("pauses every call while GitHub's rate limit is used up", async () => {
    let t = 0;
    const c = new TtlCache();
    const limited = vi.fn(async () => ({ ok: false as const, kind: "transient" as const, status: 403, retryAfterS: 120, error: "x" }));
    const r = await c.get("a", 1000, limited, () => t);
    expect(r).toMatchObject({ ok: false, error: RATE_LIMITED });
    const other = vi.fn(async () => ({ ok: true as const, data: 1 }));
    t = 60_000;
    expect(await c.get("b", 1000, other, () => t)).toMatchObject({ ok: false, error: RATE_LIMITED, retryAfterS: 60 });
    expect(other).not.toHaveBeenCalled();
    t = 121_000;
    expect(await c.get("b", 1000, other, () => t)).toEqual({ ok: true, data: 1 });
  });

  it("drops the oldest entry when full", async () => {
    const c = new TtlCache(2);
    const load = vi.fn(async () => ({ ok: true as const, data: 1 }));
    for (const k of ["a", "b", "c"]) await c.get(k, 1000, load, () => 0);
    await c.get("a", 1000, load, () => 0);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
