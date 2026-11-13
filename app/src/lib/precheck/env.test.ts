import { describe, expect, it } from "vitest";
import { addedEnvNames } from "./env";

describe("addedEnvNames", () => {
  it("lists names new in .env.example and names newly read in code that the example doesn't list", () => {
    const lines = ["const x = process.env.C;", "if (process.env.NODE_ENV) {}", "process.env.VERCEL_URL", "use(process.env.B)", `process.env["D_KEY"]`];
    expect(addedEnvNames("A=1\n", "A=1\nB=\n", lines)).toEqual({ example: ["B"], code: ["C", "D_KEY"] });
  });
  it("lists nothing from the example when the head has none", () => {
    expect(addedEnvNames("A=1", null, [])).toEqual({ example: [], code: [] });
  });
  it("treats every head name as new when the base has no example", () => {
    expect(addedEnvNames(null, "B=\nA=\n", [])).toEqual({ example: ["A", "B"], code: [] });
  });
  it("ignores CI, PORT, NEXT_RUNTIME and Vercel's own names", () => {
    expect(addedEnvNames(null, null, ["process.env.CI", "process.env.PORT", "process.env.NEXT_RUNTIME", "process.env.VERCEL", "process.env.VERCEL_ENV"]).code).toEqual([]);
  });
});
