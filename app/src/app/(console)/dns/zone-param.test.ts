import { describe, expect, it } from "vitest";
import { zoneParam } from "./zone-param";

const options = [{ id: "123e4567-e89b-42d3-a456-426614174000" }, { id: "223e4567-e89b-42d3-a456-426614174000" }];

describe("zoneParam (review m3)", () => {
  it("passes a watched zone's id through", () => {
    expect(zoneParam("223e4567-e89b-42d3-a456-426614174000", options)).toBe("223e4567-e89b-42d3-a456-426614174000");
  });
  it("turns an unknown, malformed or missing id into null, so it never becomes its own cache entry", () => {
    expect(zoneParam("923e4567-e89b-42d3-a456-426614174000", options)).toBeNull();
    expect(zoneParam("nope", options)).toBeNull();
    expect(zoneParam(undefined, options)).toBeNull();
    expect(zoneParam("123e4567-e89b-42d3-a456-426614174000", [])).toBeNull();
  });
});
