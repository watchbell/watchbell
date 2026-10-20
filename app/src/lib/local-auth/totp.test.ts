import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, newTotpSecret, totpUri, verifyTotp } from "./totp";

const SECRET = base32Encode(Buffer.from("12345678901234567890"));
const T = 1111111109_000; // step 37037036, code 081804

describe("base32", () => {
  it("matches RFC 4648 vectors without padding", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
  });
  it("rejects invalid characters", () => {
    expect(() => base32Decode("MZ1W")).toThrow();
  });
});

describe("totp", () => {
  it("newTotpSecret is 20 bytes of base32", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });
  it("builds an otpauth URI", () => {
    expect(totpUri("ABC", "a@b.co")).toBe("otpauth://totp/Watchbell:a%40b.co?secret=ABC&issuer=Watchbell&algorithm=SHA1&digits=6&period=30");
  });
  it("matches RFC 6238 SHA1 vectors", () => {
    expect(verifyTotp(SECRET, "287082", 59_000, null)).toEqual({ ok: true, step: 1 });
    expect(verifyTotp(SECRET, "081804", T, null)).toEqual({ ok: true, step: 37037036 });
  });
  it("accepts one step either side and rejects two", () => {
    expect(verifyTotp(SECRET, "081804", T + 30_000, null).ok).toBe(true);
    expect(verifyTotp(SECRET, "081804", T - 30_000, null).ok).toBe(true);
    expect(verifyTotp(SECRET, "081804", T + 60_000, null).ok).toBe(false);
    expect(verifyTotp(SECRET, "081804", T - 60_000, null).ok).toBe(false);
  });
  it("rejects a replay of the same or an earlier step", () => {
    expect(verifyTotp(SECRET, "081804", T, 37037035).ok).toBe(true);
    expect(verifyTotp(SECRET, "081804", T, 37037036).ok).toBe(false);
    expect(verifyTotp(SECRET, "081804", T, 37037040).ok).toBe(false);
  });
  it("rejects malformed codes and secrets", () => {
    expect(verifyTotp(SECRET, "28708", 59_000, null).ok).toBe(false);
    expect(verifyTotp(SECRET, "abcdef", 59_000, null).ok).toBe(false);
    expect(verifyTotp("not base32!", "287082", 59_000, null).ok).toBe(false);
    expect(verifyTotp(SECRET, "287 082", 59_000, null).ok).toBe(true);
  });
  it("fails closed on an empty or short secret", () => {
    // HMAC with an empty key is computable by anyone, so these must never verify.
    expect(verifyTotp("", "287082", 59_000, null).ok).toBe(false);
    expect(verifyTotp("A", "287082", 59_000, null).ok).toBe(false);
    expect(verifyTotp(base32Encode(Buffer.alloc(15, 1)), "000000", 59_000, null).ok).toBe(false);
  });
  it("rejects a non-finite clock", () => {
    expect(verifyTotp(SECRET, "287082", NaN, null).ok).toBe(false);
    expect(verifyTotp(SECRET, "287082", Infinity, null).ok).toBe(false);
  });
  it("percent-encodes URI parameters", () => {
    const uri = totpUri("ABC", "a b@c.co", "My Co");
    expect(uri).toContain("issuer=My%20Co");
    expect(uri).toContain("/My%20Co:a%20b%40c.co?");
    expect(uri).not.toContain("+");
  });
});
