import { describe, expect, it } from "vitest";
import type { RepoRun } from "@/db/schema";
import { CI_FRESH_MS, ciFactsFrom } from "./ci-facts-db";

const now = new Date("2026-11-04T03:00:00Z");
const run: RepoRun = { status: "completed", conclusion: "failure", name: "CI", branch: "main", sha: null, url: null, at: null, runNumber: 7 };
const row = (o: Partial<Parameters<typeof ciFactsFrom>[0][number]> = {}) => ({
  appId: "a1", repo: "me/web", branch: "main", run, checkedAt: new Date(now.getTime() - 3_600_000), goneAt: null, ...o,
});

describe("ciFactsFrom", () => {
  it("keeps a run the last sync read", () => {
    expect(ciFactsFrom([row()], now)).toEqual([{ appId: "a1", repo: "me/web", branch: "main", run }]);
  });
  // Review (final, Important 2): the sync keeps the last run it could read when Actions read is lost, so an old
  // failure must not page and must not resolve; it reads as "not read".
  it("treats a run not read again for more than two days as unknown", () => {
    expect(CI_FRESH_MS).toBe(2 * 86_400_000);
    expect(ciFactsFrom([row({ checkedAt: new Date(now.getTime() - CI_FRESH_MS - 1) })], now)).toEqual([{ appId: "a1", repo: "me/web", branch: "main", run: null }]);
    expect(ciFactsFrom([row({ checkedAt: null })], now)[0].run).toBeNull();
  });
  it("leaves out a repository the token no longer sees, and rows never read", () => {
    expect(ciFactsFrom([row({ goneAt: now })], now)).toEqual([]);
    expect(ciFactsFrom([row({ run: null, checkedAt: null })], now)).toEqual([]);
  });
});
