import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expiryDate, hashKey, hasScope, keyFormSchema, keyStatus, newApiKey, parseBearer } from "./key";

const valid = `wb_${"a".repeat(40)}`;
const legacy = `wp_${"a".repeat(40)}`; // a key made before the Watchbell rename

describe("newApiKey", () => {
  it("is wb_ plus 40 letters and digits, with the prefix and a sha256 hash", () => {
    const { key, hash, prefix } = newApiKey();
    expect(key).toMatch(/^wb_[A-Za-z0-9]{40}$/);
    expect(prefix).toBe(key.slice(0, 7));
    expect(prefix).toMatch(/^w[bp]_[A-Za-z0-9]{4}$/); // the api_keys_prefix_check constraint (0055 accepts wb_ and wp_)
    expect(hash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes 1,000 distinct keys", () => {
    expect(new Set(Array.from({ length: 1000 }, () => newApiKey().key)).size).toBe(1000);
  });

  it("uses the whole alphabet (no character is unreachable)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const c of newApiKey().key.slice(3)) seen.add(c);
    expect(seen.size).toBe(62);
  });
});

describe("hashKey", () => {
  it("is the sha256 hex of the key", () => {
    expect(hashKey("wp_x")).toBe(createHash("sha256").update("wp_x").digest("hex"));
  });
});

describe("parseBearer", () => {
  it("accepts Bearer wb_ with 40 characters", () => {
    expect(parseBearer(`Bearer ${valid}`)).toBe(valid);
  });
  it("still accepts a wp_ key made before the rename (MCP clients, the VM agent)", () => {
    expect(parseBearer(`Bearer ${legacy}`)).toBe(legacy);
    expect(hashKey(legacy)).toBe(createHash("sha256").update(legacy).digest("hex"));
  });
  it("accepts a lower-case scheme and trims extra spaces", () => {
    expect(parseBearer(`bearer ${valid}`)).toBe(valid);
    expect(parseBearer(`  Bearer    ${valid}   `)).toBe(valid);
  });
  it("rejects a missing header, another scheme, another prefix and the wrong length", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(valid)).toBeNull();
    expect(parseBearer(`Basic ${valid}`)).toBeNull();
    expect(parseBearer(`Bearer hb_${"a".repeat(40)}`)).toBeNull();
    expect(parseBearer(`Bearer wp_${"a".repeat(39)}`)).toBeNull();
    expect(parseBearer(`Bearer wp_${"a".repeat(41)}`)).toBeNull();
    expect(parseBearer(`Bearer wp_${"a".repeat(39)}-`)).toBeNull();
    expect(parseBearer(`Bearer wb_${"a".repeat(39)}`)).toBeNull();
    expect(parseBearer(`Bearer wx_${"a".repeat(40)}`)).toBeNull();
    expect(parseBearer(`Bearer wr_${"a".repeat(40)}`)).toBeNull();
    expect(parseBearer(`Bearer ${valid} extra`)).toBeNull();
  });
});

describe("hasScope", () => {
  it("any needs at least one scope, a named scope needs that scope", () => {
    expect(hasScope(["read:status"], "any")).toBe(true);
    expect(hasScope([], "any")).toBe(false);
    expect(hasScope(["read:status"], "read:status")).toBe(true);
    expect(hasScope(["read:status"], "ai:invoke")).toBe(false);
  });
});

describe("keyFormSchema", () => {
  const ok = { name: "portfolio-advisor", scopes: ["ai:invoke"], expiry: "90d", ratePerMin: 20 };
  it("accepts a normal form and coerces the rate from a form string", () => {
    expect(keyFormSchema.parse(ok)).toEqual(ok);
    expect(keyFormSchema.parse({ ...ok, ratePerMin: "30" }).ratePerMin).toBe(30);
  });
  it("checks the name", () => {
    for (const name of ["a", "A-b", "has space", "x".repeat(41), "under_score", ""]) expect(keyFormSchema.safeParse({ ...ok, name }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...ok, name: "ab" }).success).toBe(true);
    expect(keyFormSchema.safeParse({ ...ok, name: "x".repeat(40) }).success).toBe(true);
  });
  it("needs at least one known scope and drops duplicates", () => {
    expect(keyFormSchema.safeParse({ ...ok, scopes: [] }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...ok, scopes: ["admin"] }).success).toBe(false);
    expect(keyFormSchema.parse({ ...ok, scopes: ["ai:invoke", "ai:invoke", "read:status"] }).scopes).toEqual(["ai:invoke", "read:status"]);
  });
  it("limits the expiry choices and the rate to 1-600 whole numbers", () => {
    for (const expiry of ["7d", "30d", "90d", "1y", "never"]) expect(keyFormSchema.safeParse({ ...ok, expiry }).success).toBe(true);
    expect(keyFormSchema.safeParse({ ...ok, expiry: "2y" }).success).toBe(false);
    for (const ratePerMin of [0, 601, 1.5, -1, "abc", ""]) expect(keyFormSchema.safeParse({ ...ok, ratePerMin }).success).toBe(false);
    for (const ratePerMin of [1, 600]) expect(keyFormSchema.safeParse({ ...ok, ratePerMin }).success).toBe(true);
  });
  it("rejects unknown fields", () => {
    expect(keyFormSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("expiryDate", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  it("adds the chosen period, never is null", () => {
    expect(expiryDate("7d", now)?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(expiryDate("30d", now)?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(expiryDate("90d", now)?.toISOString()).toBe("2027-01-11T00:00:00.000Z");
    expect(expiryDate("1y", now)?.toISOString()).toBe("2027-10-13T00:00:00.000Z");
    expect(expiryDate("never", now)).toBeNull();
  });
});

describe("keyStatus", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const row = { revokedAt: null, expiresAt: null, lastUsedAt: new Date("2026-10-13T11:00:00Z") };
  it("tells active, never used, expired and revoked apart (revoked wins)", () => {
    expect(keyStatus(row, now)).toBe("active");
    expect(keyStatus({ ...row, lastUsedAt: null }, now)).toBe("never-used");
    expect(keyStatus({ ...row, expiresAt: new Date("2026-10-13T11:59:59Z") }, now)).toBe("expired");
    expect(keyStatus({ ...row, expiresAt: new Date("2026-10-14T00:00:00Z") }, now)).toBe("active");
    expect(keyStatus({ ...row, revokedAt: new Date("2026-10-13T10:00:00Z"), expiresAt: new Date("2026-10-13T11:00:00Z") }, now)).toBe("revoked");
  });
});
