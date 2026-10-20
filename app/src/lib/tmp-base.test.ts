import path from "node:path";
import { describe, expect, it } from "vitest";
import { pickBase } from "../../test/tmp-base";

describe("test scratch folder (app/test/tmp-base.ts)", () => {
  it("reads WATCHBELL_TEST_TMP first, then the old WATCHPOST_TEST_TMP", () => {
    expect(pickBase({ WATCHBELL_TEST_TMP: "D:/scratch/new", WATCHPOST_TEST_TMP: "D:/scratch/old" })).toBe("D:/scratch/new");
    expect(pickBase({ WATCHPOST_TEST_TMP: "D:/scratch/old" })).toBe("D:/scratch/old");
    expect(pickBase({ WATCHBELL_TEST_TMP: " ", WATCHPOST_TEST_TMP: "D:/scratch/old" })).toBe("D:/scratch/old");
  });
  it("else <repo>/.cache/tmp, never the OS temp folder", () => {
    expect(pickBase({})).toBe(path.resolve(__dirname, "../../../.cache/tmp"));
  });
});
