import { describe, expect, it } from "vitest";
import { parseReadGaps, readGapsKey, readGapsText } from "./read-gaps";

describe("GitHub read gaps (1.2.3: the daily sync no longer fails silently)", () => {
  it("says nothing when the last sync read everything", () => {
    expect(readGapsText({ at: "2026-10-26T00:00:00Z", actionsDenied: 0, contentsDenied: 0 }, null)).toBeNull();
    expect(readGapsText(null, null)).toBeNull();
  });

  it("names the missing permission and when Actions was last read", () => {
    expect(readGapsText({ at: "2026-10-26T00:00:00Z", actionsDenied: 12, contentsDenied: 0 }, new Date("2026-10-15T20:07:43Z")))
      .toBe("Actions can't be read on 12 repositories (last read 15 Oct): give the token Actions: Read.");
    expect(readGapsText({ at: "2026-10-26T00:00:00Z", actionsDenied: 1, contentsDenied: 2 }, null))
      .toBe("Actions can't be read on 1 repository: give the token Actions: Read. package.json can't be read on 2 repositories: give the token Contents: Read.");
  });

  it("parses only a well-formed setting", () => {
    expect(parseReadGaps({ at: "x", actionsDenied: 3, contentsDenied: -1 })).toEqual({ at: "x", actionsDenied: 3, contentsDenied: 0 });
    expect(parseReadGaps({ actionsDenied: 3 })).toBeNull();
    expect(parseReadGaps("nope")).toBeNull();
    expect(readGapsKey("a1")).toBe("github.readGaps.a1");
  });
});
