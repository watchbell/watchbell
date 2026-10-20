import { describe, expect, it } from "vitest";
import { logQuery, parseLogParams } from "./filter";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("parseLogParams", () => {
  it("reads the known filters", () => {
    expect(parseLogParams({ key: UUID, status: "limit", client: " gemini-cli ", model: "gemini", page: "3" })).toEqual({
      filter: { keyId: UUID, status: "limit", client: "gemini-cli", model: "gemini" }, page: 3,
    });
  });
  it("drops anything unrecognised", () => {
    expect(parseLogParams({ key: "x' or 1=1", status: "all", client: "", page: "-2" })).toEqual({ filter: {}, page: 1 });
    expect(parseLogParams({ page: "abc" }).page).toBe(1);
    expect(parseLogParams({ page: "999999" }).page).toBe(2000);
  });
  it("takes the first of a repeated parameter and caps lengths", () => {
    expect(parseLogParams({ status: ["error", "ok"] }).filter.status).toBe("error");
    expect(parseLogParams({ client: "x".repeat(500) }).filter.client).toHaveLength(60);
  });
});

describe("logQuery", () => {
  it("round-trips and leaves page 1 out", () => {
    expect(logQuery({})).toBe("");
    const f = { keyId: UUID, status: "error" as const, client: "open claw" };
    const q = logQuery(f, 2);
    expect(q).toBe(`?key=${UUID}&status=error&client=open+claw&page=2`);
    expect(parseLogParams(Object.fromEntries(new URLSearchParams(q)))).toEqual({ filter: f, page: 2 });
  });
});
