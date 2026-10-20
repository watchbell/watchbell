import { describe, expect, it } from "vitest";
import { envName, LEGACY_ENV_PREFIX, readEnv, readEnvNamed } from "./brand-env";

describe("readEnv (WATCHBELL_* first, then the old WATCHPOST_* name)", () => {
  it("names the new variable", () => {
    expect(envName("MODE")).toBe("WATCHBELL_MODE");
    expect(LEGACY_ENV_PREFIX).toBe("WATCHPOST_");
  });
  it("WATCHBELL_* wins when both are set", () => {
    expect(readEnv({ WATCHBELL_MODE: "selfhost", WATCHPOST_MODE: "demo" }, "MODE")).toBe("selfhost");
  });
  it("falls back to WATCHPOST_* (an existing env file, the owner's Vercel env)", () => {
    expect(readEnv({ WATCHPOST_MODE: "selfhost" }, "MODE")).toBe("selfhost");
    expect(readEnv({ WATCHPOST_DATA_DIR: "/srv/data" }, "DATA_DIR")).toBe("/srv/data");
  });
  it("an empty or blank WATCHBELL_* counts as unset", () => {
    expect(readEnv({ WATCHBELL_MODE: "", WATCHPOST_MODE: "demo" }, "MODE")).toBe("demo");
    expect(readEnv({ WATCHBELL_MODE: "  ", WATCHPOST_MODE: "demo" }, "MODE")).toBe("demo");
    expect(readEnv({ WATCHBELL_MODE: "" }, "MODE")).toBe("");
  });
  it("names the variable that supplied the value", () => {
    expect(readEnvNamed({ WATCHBELL_MODE: "x", WATCHPOST_MODE: "y" }, "MODE")).toEqual({ name: "WATCHBELL_MODE", value: "x" });
    expect(readEnvNamed({ WATCHPOST_MODE: "y" }, "MODE")).toEqual({ name: "WATCHPOST_MODE", value: "y" });
    expect(readEnvNamed({ WATCHBELL_MODE: " ", WATCHPOST_MODE: "y" }, "MODE")).toEqual({ name: "WATCHPOST_MODE", value: "y" });
    expect(readEnvNamed({}, "MODE")).toBeUndefined();
  });
  it("is undefined when neither is set", () => {
    expect(readEnv({}, "MODE")).toBeUndefined();
    expect(readEnv({ OTHER: "x" }, "DATA_DIR")).toBeUndefined();
  });
});
