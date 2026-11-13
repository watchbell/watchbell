import { describe, expect, it } from "vitest";
import type { Dep } from "@/lib/deps/lockfile";
import { addedDeps, nextVersions } from "./diff";

const d = (name: string, version: string, dev = false): Dep => ({ name, version, dev });

describe("addedDeps", () => {
  it("keeps only the name@version pairs the base doesn't have", () => {
    expect(addedDeps([d("a", "1.0.0"), d("b", "2.0.0")], [d("a", "1.0.1"), d("b", "2.0.0"), d("c", "1.0.0")])).toEqual([d("a", "1.0.1"), d("c", "1.0.0")]);
  });
  it("treats every head package as added when the base has no lockfile", () => {
    expect(addedDeps(null, [d("a", "1.0.0")])).toEqual([d("a", "1.0.0")]);
  });
});

describe("nextVersions", () => {
  it("names the Next.js version on both sides", () => {
    expect(nextVersions([d("next", "16.4.2")], [d("next", "16.4.3")])).toEqual({ from: "16.4.2", to: "16.4.3" });
  });
  it("is null where next isn't installed", () => {
    expect(nextVersions(null, [d("react", "19.2.4")])).toEqual({ from: null, to: null });
  });
  it("picks the highest when a lockfile has more than one next", () => {
    expect(nextVersions(null, [d("next", "15.5.7"), d("next", "16.4.2")]).to).toBe("16.4.2");
  });
});
