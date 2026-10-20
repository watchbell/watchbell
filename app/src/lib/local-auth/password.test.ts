import { describe, expect, it } from "vitest";
import { dummyVerify, hashPassword, newTemporaryPassword, passwordProblem, verifyPassword } from "./password";

describe("password", () => {
  it("round-trips and rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
  });
  it("uses the documented stored format and a fresh salt", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    const [tag, n, r, p, salt, hash] = a.split("$");
    expect([tag, n, r, p]).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(Buffer.from(hash, "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
  it("returns false for malformed stored values", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$a$b")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$8$1$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA")).toBe(false);
  });
  it("pins parameters and caps verify length", async () => {
    expect(await verifyPassword("x", "scrypt$32768$8$16$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(43) + "=")).toBe(false);
    expect(await verifyPassword("x", "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(43) + "=")).toBe(false);
    expect(await verifyPassword("x", "scrypt$+32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(43) + "=")).toBe(false);
    const stored = await hashPassword("correct horse battery");
    const t1 = Date.now();
    expect(await verifyPassword("a".repeat(1025), stored)).toBe(false);
    expect(Date.now() - t1).toBeLessThan(50);
  });
  it("enforces length rules", () => {
    expect(passwordProblem("a".repeat(11))).toBe("Use at least 12 characters.");
    expect(passwordProblem("a".repeat(12))).toBeNull();
    expect(passwordProblem("a".repeat(200))).toBeNull();
    expect(passwordProblem("a".repeat(201))).toBe("Use at most 200 characters.");
  });
  it("dummyVerify resolves", async () => {
    await expect(dummyVerify()).resolves.toBeUndefined();
  });
});

describe("newTemporaryPassword", () => {
  it("is 20 unambiguous characters, passes the password rules and differs every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = newTemporaryPassword();
      expect(p).toMatch(/^[a-km-np-z2-9]{20}$/);
      expect(passwordProblem(p)).toBeNull();
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
