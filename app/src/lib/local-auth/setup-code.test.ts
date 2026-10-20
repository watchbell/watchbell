import { describe, expect, it } from "vitest";
import { SETUP_CODE_ALPHABET, hashSetupCode, newSetupCode } from "./setup-code";

const KEY = Buffer.alloc(32, 7);

describe("setup code", () => {
  it("is 10 unambiguous characters with a matching hash", () => {
    for (let i = 0; i < 50; i++) {
      const { code, hash } = newSetupCode(KEY);
      expect(code).toHaveLength(10);
      expect([...code].every((c) => SETUP_CODE_ALPHABET.includes(c))).toBe(true);
      expect(hash).toBe(hashSetupCode(code, KEY));
    }
  });
  it("leaves out look-alike characters", () => {
    for (const c of "0O1IL") expect(SETUP_CODE_ALPHABET).not.toContain(c);
  });
  it("normalises typed input", () => {
    const h = hashSetupCode("ABCDEFGH23", KEY);
    expect(hashSetupCode("  abcdefgh23 ", KEY)).toBe(h);
    expect(hashSetupCode("ABCDE-FGH23", KEY)).toBe(h);
    expect(hashSetupCode("ABCDE FGH23", KEY)).toBe(h);
    expect(hashSetupCode("ABCDEFGH24", KEY)).not.toBe(h);
  });
  it("depends on the key", () => {
    expect(hashSetupCode("ABCDEFGH23", KEY)).not.toBe(hashSetupCode("ABCDEFGH23", Buffer.alloc(32, 8)));
    expect(hashSetupCode("ABCDEFGH23", KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});
