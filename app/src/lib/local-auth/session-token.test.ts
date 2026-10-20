import { describe, expect, it } from "vitest";
import { hashToken, newSessionToken } from "./session-token";

describe("session token", () => {
  it("is 43 base64url chars with a stable sha256 hash", () => {
    const { token, hash } = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("is unique per call", () => {
    expect(newSessionToken().token).not.toBe(newSessionToken().token);
  });
});
