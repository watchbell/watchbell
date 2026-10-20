import { afterEach, describe, expect, it, vi } from "vitest";

const KEY_B64 = Buffer.alloc(32, 5).toString("base64");
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "wp_demo" && jar.value !== undefined ? { name, value: jar.value } : undefined) }),
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64 }) }));

import { demoCookieKey, signDemoCookie } from "./cookie";
import { currentDemoEmail, currentDemoSeed, readDemoVisitor, setDemoVisitorResolverForTests } from "./session";

const KEY = demoCookieKey(KEY_B64);
const SEED = "0123456789abcdef0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  jar.value = undefined;
  setDemoVisitorResolverForTests(undefined);
});

describe("demo session", () => {
  it("reads seed and email from a wp_demo cookie this server signed", async () => {
    jar.value = signDemoCookie({ email: "a@visitor.test", seed: SEED }, KEY);
    expect(await currentDemoSeed()).toBe(SEED);
    expect(await currentDemoEmail()).toBe("a@visitor.test");
  });

  it("is signed out without a cookie, or with one that is tampered with, expired or signed with another key", async () => {
    const good = signDemoCookie({ email: "a@visitor.test", seed: SEED }, KEY);
    const [payload, mac] = good.split(".");
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const swapped = Buffer.from(JSON.stringify({ ...body, email: "b@visitor.test" })).toString("base64url");
    for (const value of [
      undefined,
      "",
      "not-base64-json.mac",
      `${swapped}.${mac}`,
      signDemoCookie({ email: "a@visitor.test", seed: SEED }, KEY, Date.now() - 8 * DAY_MS),
      signDemoCookie({ email: "a@visitor.test", seed: SEED }, Buffer.alloc(32, 6)),
      signDemoCookie({ email: "a@visitor.test", seed: SEED }, Buffer.from(KEY_B64, "base64")), // the raw key, not the sub-key
    ]) {
      jar.value = value;
      expect(await readDemoVisitor()).toBeNull();
      await expect(currentDemoSeed()).rejects.toThrow("Not signed in to the demo");
    }
  });

  it("uses the test resolver when one is set", async () => {
    setDemoVisitorResolverForTests(async () => ({ seed: "s", email: "t@visitor.test" }));
    expect(await currentDemoSeed()).toBe("s");
    expect(await currentDemoEmail()).toBe("t@visitor.test");
  });
});
