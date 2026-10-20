import { describe, expect, it } from "vitest";
import { filterRows } from "./filter";

const rows = [
  { key: "1", state: "ok", text: "portfolio-site Running portfolio.example.com" },
  { key: "2", state: "err", text: "orbit-blog Down · HTTP 502" },
  { key: "3", state: "ok", text: "nova-wallet Running" },
];

describe("filterRows", () => {
  it("matches any text in the row, ignoring case", () => {
    expect(filterRows(rows, { text: "ORBIT", state: "" }).map((r) => r.key)).toEqual(["2"]);
  });
  it("filters by state", () => {
    expect(filterRows(rows, { text: "", state: "ok" }).map((r) => r.key)).toEqual(["1", "3"]);
  });
  it("combines both and trims the text", () => {
    expect(filterRows(rows, { text: " nova ", state: "ok" }).map((r) => r.key)).toEqual(["3"]);
  });
  it("keeps every row without filters", () => {
    expect(filterRows(rows, { text: "", state: "" })).toHaveLength(3);
  });
});

describe("filterRows with an account select", () => {
  it("keeps only the rows of the chosen account", () => {
    const grouped = [{ key: "a", state: "ok", text: "x", group: "utama" }, { key: "b", state: "ok", text: "y", group: "kedua" }];
    expect(filterRows(grouped, { text: "", state: "", group: "kedua" }).map((r) => r.key)).toEqual(["b"]);
  });
});

describe("filterRows tag chip (Models › Working only)", () => {
  it("keeps only rows carrying the tag; no tag = every row", () => {
    const rows = [{ key: "a", state: "ok", text: "a", tags: ["working"] }, { key: "b", state: "ok", text: "b" }];
    expect(filterRows(rows, { text: "", state: "", tag: "working" }).map((r) => r.key)).toEqual(["a"]);
    expect(filterRows(rows, { text: "", state: "" })).toHaveLength(2);
  });
});
