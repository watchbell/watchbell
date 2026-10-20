import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: h.revalidateTag, updateTag: h.updateTag }));

import { expireTags, updateTags } from "./invalidate";

beforeEach(() => {
  h.revalidateTag.mockReset();
  h.updateTag.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("expireTags (collector, route handlers)", () => {
  it("expires each tag at once (expire: 0), so the next read never gets the old value", () => {
    expireTags(["db:neon", "status", "db:neon"]);
    expect(h.revalidateTag.mock.calls).toEqual([["db:neon", { expire: 0 }], ["status", { expire: 0 }]]);
  });
  it("a tag that can't be expired (no request around it) doesn't stop the others or the caller", () => {
    h.revalidateTag.mockImplementationOnce(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => expireTags(["db:supabase", "db:firebase"])).not.toThrow();
    expect(h.revalidateTag).toHaveBeenCalledTimes(2);
  });
  it("does nothing for no tags", () => {
    expireTags([]);
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });
});

describe("updateTags (server actions: read your own write)", () => {
  it("calls updateTag once per tag", () => {
    updateTags(["net:domains", "net:zones"]);
    expect(h.updateTag.mock.calls).toEqual([["net:domains"], ["net:zones"]]);
  });
  it("never turns a saved change into an error", () => {
    h.updateTag.mockImplementation(() => {
      throw new Error("updateTag can only be called from within a Server Action");
    });
    expect(() => updateTags(["status"])).not.toThrow();
  });
});

describe("outside cloud nothing is cached (cached.ts reads straight through), so there is nothing to expire", () => {
  it.each(["selfhost", "demo"])("in %s expireTags and updateTags are no-ops and log nothing", (m) => {
    vi.stubEnv("WATCHPOST_MODE", m);
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expireTags(["db:neon", "status"]);
    updateTags(["net:zones"]);
    expect(h.revalidateTag).not.toHaveBeenCalled();
    expect(h.updateTag).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("cloud (unset) still expires", () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    expireTags(["status"]);
    expect(h.revalidateTag).toHaveBeenCalledWith("status", { expire: 0 });
  });
});
