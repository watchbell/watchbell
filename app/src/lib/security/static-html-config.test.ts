import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICE_FRAME_PATH } from "./static-html";

// next.config.ts keeps the office path as a literal (plain Node loads it in the export tests); it must match.
describe("next.config.ts office frame path", () => {
  it("is the same path as OFFICE_FRAME_PATH", () => {
    const config = readFileSync(join(__dirname, "../../../next.config.ts"), "utf8");
    expect(config).toContain(`const OFFICE_FRAME_PATH = "${OFFICE_FRAME_PATH}";`);
  });
});
