import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../next.config";
import { changelogVersion } from "./self-update";

// Owner 13 Nov: the cloud build carries the newest CHANGELOG version (public-edition/CHANGELOG.md here, CHANGELOG.md
// at the root of a public export), so a console built from source shows the release it runs.
describe("next.config.ts build version", () => {
  it("is the newest version of the CHANGELOG", () => {
    const file = ["../../../public-edition/CHANGELOG.md", "../../../CHANGELOG.md"].map((p) => join(__dirname, p)).find((p) => existsSync(p));
    expect(file).toBeDefined();
    expect(config.env?.WATCHBELL_BUILD_VERSION).toBe(changelogVersion(readFileSync(file as string, "utf8")));
    expect(config.env?.WATCHBELL_BUILD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
