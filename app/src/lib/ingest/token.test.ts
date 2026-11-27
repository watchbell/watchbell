import { describe, expect, it } from "vitest";
import { tokenHash } from "@/lib/heartbeat-token";
import { INGEST_TOKEN, newIngestToken } from "./token";

describe("newIngestToken", () => {
  it("is am_ + 22 base-58 characters, stored as sha256, shown with a 7-character prefix", () => {
    for (let i = 0; i < 200; i++) {
      const t = newIngestToken();
      expect(t.token).toMatch(INGEST_TOKEN);
      expect(t.hash).toBe(tokenHash(t.token));
      expect(t.prefix).toBe(t.token.slice(0, 7));
      expect(t.prefix).toHaveLength(7);
    }
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newIngestToken().token));
    expect(seen.size).toBe(500);
  });

  it("rejects other shapes", () => {
    for (const bad of ["am_short", "hb_0123456789abcdef0123456789abcdef", "am_0OIl000000000000000000", "am_" + "a".repeat(23), "AM_" + "a".repeat(22)]) {
      expect(bad).not.toMatch(INGEST_TOKEN);
    }
  });
});
