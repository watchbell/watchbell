import { describe, expect, it, vi } from "vitest";

vi.mock("./pr-actions", () => ({ prChecksAction: vi.fn() }));

import type { PrCheckRow } from "@/lib/precheck/pr-checks";
import { prCounts, prRowStatus } from "./pr-card";

const counts = { critical: 0, high: 0, moderate: 0, low: 0, secrets: 0, env: 0 };
const row = (o: Partial<PrCheckRow>): PrCheckRow => ({ number: 1, title: "t", url: null, draft: false, state: "checked", marker: { v: 1, sha: "abcdef0", verdict: "ok", at: "x", counts }, ...o });

describe("prRowStatus", () => {
  it("says what the check found on the pull request's latest commit", () => {
    expect(prRowStatus(row({}))).toEqual({ state: "ok", label: "No new problems" });
    expect(prRowStatus(row({ marker: { v: 1, sha: "abcdef0", verdict: "fix", at: "x", counts } }))).toEqual({ state: "err", label: "Fix before merging" });
    expect(prRowStatus(row({ marker: { v: 1, sha: "abcdef0", verdict: "check", at: "x", counts } }))).toEqual({ state: "warn", label: "Check before merging" });
  });
  it("says when the comment is for an older commit, or missing", () => {
    expect(prRowStatus(row({ state: "old" }))).toEqual({ state: "unknown", label: "Checked an older commit" });
    expect(prRowStatus(row({ state: "none", marker: null }))).toEqual({ state: "off", label: "Not checked — add the pre-deploy check to this repository" });
    expect(prRowStatus(row({ state: "unread", marker: null }))).toEqual({ state: "unknown", label: "Couldn't read this pull request's comments" });
  });
});

describe("prCounts", () => {
  it("lists what was found, in plain words", () => {
    expect(prCounts({ ...counts, critical: 1, high: 2, secrets: 1, env: 3 })).toBe("1 critical, 2 high, 1 possible secret, 3 env names");
    expect(prCounts({ ...counts, moderate: 1, low: 2 })).toBe("1 moderate, 2 low");
    expect(prCounts(counts)).toBe("");
  });
});
