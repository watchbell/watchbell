import { describe, expect, it } from "vitest";
import { compactCount, KEY_FILTER_STATES, keyView } from "./view";

const now = new Date("2026-10-13T05:30:00Z"); // 12:30 WIB
const base = { createdAt: new Date("2026-10-13T00:12:00Z"), expiresAt: null, revokedAt: null, lastUsedAt: null };

describe("keyView", () => {
  it("an active key shows its dates in WIB and 'N min ago'", () => {
    const v = keyView({ ...base, expiresAt: new Date("2027-01-12T05:00:00Z"), lastUsedAt: new Date("2026-10-13T05:28:00Z") }, now);
    expect(v).toMatchObject({ status: "active", state: "ok", label: "Active", created: "13 Oct 07:12", expires: "12 Jan 2027", lastUsed: "2 min ago" });
  });
  it("a key without expiry says Never, and one never used says so", () => {
    expect(keyView(base, now)).toMatchObject({ status: "never-used", state: "idle", label: "Never used", expires: "Never", lastUsed: "Never used" });
  });
  it("a revoked key says when, an expired one is warned", () => {
    expect(keyView({ ...base, revokedAt: new Date("2026-10-12T03:00:00Z"), lastUsedAt: new Date("2026-10-10T03:00:00Z") }, now)).toMatchObject({ status: "revoked", state: "off", expires: "Revoked 12 Oct" });
    expect(keyView({ ...base, expiresAt: new Date("2026-10-12T00:00:00Z"), lastUsedAt: new Date("2026-10-10T03:00:00Z") }, now)).toMatchObject({ status: "expired", state: "warn", label: "Expired", expires: "12 Oct 2026" });
  });
  it("every state the table can show is in the filter", () => {
    expect(KEY_FILTER_STATES.map(([v]) => v)).toEqual(["ok", "idle", "warn", "off"]);
  });
});

describe("compactCount", () => {
  it("abbreviates thousands and millions", () => {
    expect([0, 7, 999, 1000, 61_200, 88_449, 999_999, 1_250_000].map(compactCount)).toEqual(["0", "7", "999", "1k", "61.2k", "88.4k", "1M", "1.3M"]);
  });
});
