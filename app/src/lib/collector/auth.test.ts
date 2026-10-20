import { describe, expect, it } from "vitest";
import { bearerOk } from "./auth";

const secret = "s".repeat(40);
describe("bearerOk", () => {
  it("accepts the exact bearer secret only", () => {
    expect(bearerOk(`Bearer ${secret}`, secret)).toBe(true);
    expect(bearerOk(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerOk(secret, secret)).toBe(false);
    expect(bearerOk(null, secret)).toBe(false);
    expect(bearerOk("Bearer ", "")).toBe(false);
  });
});
