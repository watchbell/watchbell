import { describe, expect, it, vi } from "vitest";

vi.mock("./buildfiles-actions", () => ({ buildFilesAction: vi.fn(), buildFilesPrAction: vi.fn() }));

import { fileLabel, guessedNote, prHint } from "./buildfiles-card";

describe("guessedNote", () => {
  it("says which facts were guessed, or nothing", () => {
    expect(guessedNote([])).toBeNull();
    expect(guessedNote(["Node version", "package manager"])).toBe("Guessed: Node version, package manager. Check them before using the files.");
  });
});

describe("fileLabel", () => {
  it("names a tab after the file, not its folder", () => {
    expect(fileLabel("apps/web/Dockerfile")).toBe("Dockerfile");
    expect(fileLabel(".github/workflows/ci.yml")).toBe("ci.yml");
  });
});

describe("prHint, minor fix M10", () => {
  it("says pull requests are off in the demo, else where they go", () => {
    expect(prHint(true, "acme/storefront")).toBe("Pull requests are off in the demo.");
    expect(prHint(false, "acme/storefront")).toBe("On a new branch of acme/storefront; files it already has are never overwritten.");
  });
});
