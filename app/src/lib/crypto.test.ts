import { describe, expect, it } from "vitest";
import { open, openOrNull, seal } from "./crypto";

const key = Buffer.alloc(32, 3).toString("base64");
const otherKey = Buffer.alloc(32, 4).toString("base64");

describe("crypto", () => {
  it("round-trips text, including non-ASCII", () => {
    const secret = "sbp_rahasia-🔑-token";
    expect(open(seal(secret, key), key)).toBe(secret);
  });

  it("uses a fresh IV every time", () => {
    const a = seal("same", key);
    const b = seal("same", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses the wrong key without leaking the plaintext", () => {
    const sealed = seal("top-secret-value", key);
    expect(() => open(sealed, otherKey)).toThrow();
    try {
      open(sealed, otherKey);
    } catch (e) {
      expect(String(e)).not.toContain("top-secret-value");
    }
    expect(openOrNull(sealed, otherKey)).toBeNull();
  });

  it("detects tampering", () => {
    const sealed = seal("value", key);
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(openOrNull({ ...sealed, ciphertext: bytes.toString("base64") }, key)).toBeNull();
  });

  it("round-trips an empty plaintext", () => {
    expect(open(seal("", key), key)).toBe("");
  });

  it("treats a ciphertext shorter than the tag as damaged", () => {
    const sealed = { ...seal("value", key), ciphertext: Buffer.alloc(8).toString("base64") };
    expect(() => open(sealed, key)).toThrow(/damaged/);
    expect(openOrNull(sealed, key)).toBeNull();
  });

  it("rejects keys that aren't 32 bytes", () => {
    expect(() => seal("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
