import { afterEach, describe, expect, it, vi } from "vitest";
import { soft } from "./soft";

// 1.8.1 (driver audit): side reads fall back to a safe value when they fail, but they used to do it silently, which
// hid the All workspaces bug on Overview and Applications (15 Nov). soft() keeps the fallback and leaves a log line
// with the error's name and code only: never its message, which can carry values from the query.
afterEach(() => vi.restoreAllMocks());

describe("soft", () => {
  it("passes a value through", async () => {
    await expect(soft(Promise.resolve(7), 0, "count")).resolves.toBe(7);
  });

  it("falls back and logs the label, name and code, not the message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const e = Object.assign(new TypeError("secret value 123"), { code: "ERR_X" });
    await expect(soft(Promise.reject(e), 0, "unsorted count")).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith("[watchbell] unsorted count failed:", "TypeError", "ERR_X");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret value");
  });

  it("copes with a non-Error rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(soft(Promise.reject("nope"), null, "x")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("[watchbell] x failed:", "string", undefined);
  });
});

// Final review I1: drizzle wraps every failed query in DrizzleQueryError (name "Error", no code, the query and its
// parameters in the message); the driver's own error is its cause. Log the cause's name and code, never the params.
describe("soft with a drizzle query error", () => {
  it("logs the driver error's name and code from the cause", async () => {
    const { DrizzleQueryError } = await import("drizzle-orm/errors");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cause = Object.assign(new TypeError("Received an instance of Date"), { code: "ERR_INVALID_ARG_TYPE" });
    const e = new DrizzleQueryError("select 1 where x = $1", ["secret-param"], cause);
    await soft(Promise.reject(e), 0, "unsorted count");
    expect(warn).toHaveBeenCalledWith("[watchbell] unsorted count failed:", "TypeError", "ERR_INVALID_ARG_TYPE");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-param");
  });
});
