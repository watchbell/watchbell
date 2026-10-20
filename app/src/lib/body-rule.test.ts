import { describe, expect, it } from "vitest";
import { bodyProblem, parsePath, ruleFrom } from "./body-rule";

describe("parsePath", () => {
  it("accepts dots and array indexes only", () => {
    expect(parsePath("status")).toEqual(["status"]);
    expect(parsePath("checks.db")).toEqual(["checks", "db"]);
    expect(parsePath("items[0].state")).toEqual(["items", 0, "state"]);
    for (const bad of ["", "a..b", "a[x]", "a.b()", "$..x", "a[-1]", "constructor.prototype"]) expect(parsePath(bad)).toBeNull();
  });
});

describe("bodyProblem", () => {
  it("checks a keyword, case-sensitive", () => {
    expect(bodyProblem({ kind: "contains", text: '"status":"ok"' }, '{"status":"ok"}', false)).toBeNull();
    expect(bodyProblem({ kind: "contains", text: "OK" }, "ok", false)).toBe("Keyword not found");
    expect(bodyProblem({ kind: "contains", text: "OK" }, "x", true)).toBe("Keyword not found in the first 256 KB");
  });
  it("compares a JSON value as text", () => {
    const r = { kind: "json" as const, path: "checks.db", equals: "ok" };
    expect(bodyProblem(r, '{"checks":{"db":"ok"}}', false)).toBeNull();
    expect(bodyProblem({ ...r, path: "up", equals: "true" }, '{"up":true}', false)).toBeNull();
    expect(bodyProblem(r, '{"checks":{"db":"down"}}', false)).toBe('JSON checks.db is "down", expected "ok"');
    expect(bodyProblem(r, '{"checks":{}}', false)).toBe("JSON checks.db is missing");
    expect(bodyProblem(r, "<html>", false)).toBe("Response isn't JSON");
    expect(bodyProblem(r, '{"checks":', true)).toBe("Response is larger than 256 KB");
  });
  it("never walks into prototypes", () => {
    expect(bodyProblem({ kind: "json", path: "toString", equals: "x" }, "{}", false)).toBe("JSON toString is missing");
  });
});

describe("ruleFrom", () => {
  it("builds the rule a monitor has, if any", () => {
    expect(ruleFrom({ bodyContains: "ok", jsonPath: null, jsonEquals: null })).toEqual({ kind: "contains", text: "ok" });
    expect(ruleFrom({ bodyContains: null, jsonPath: "status", jsonEquals: "ok" })).toEqual({ kind: "json", path: "status", equals: "ok" });
    expect(ruleFrom({ bodyContains: null, jsonPath: null, jsonEquals: null })).toBeNull();
  });
});
