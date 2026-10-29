import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in this test"); } }));

import type { Commit } from "@/lib/providers/github-browse";
import { type ReleaseNotesDeps, releaseNotesFor } from "./release-notes-db";

const APP = "11111111-1111-4111-8111-111111111111";
const THIS = { commitSha: "b".repeat(40), createdAt: new Date("2026-10-29T03:00:00Z") };
const PREV = { commitSha: "a".repeat(40) };
const commit = (i: number): Commit => ({ sha: String(i).padStart(40, "0"), title: `change ${i}`, author: "me", at: null, url: null });

function deps(over: Partial<ReleaseNotesDeps> = {}): ReleaseNotesDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    deployment: async () => THIS,
    previous: async (_app, before) => { asked.push(before); return PREV; },
    repo: async () => ({ fullName: "acme/shop" }),
    githubToken: async () => "gt",
    compare: async () => ({ ok: true, data: { commits: [commit(2), commit(1)], total: 2 } }),
    ...over,
  };
}

describe("releaseNotesFor", () => {
  it("lists the commits since the previous production deployment", async () => {
    const d = deps();
    expect(await releaseNotesFor(APP, "dpl_x", d)).toEqual({ ok: true, data: {
      from: PREV.commitSha, to: THIS.commitSha, commits: [commit(2), commit(1)], total: 2, cut: false, note: null,
    } });
    expect(d.asked).toEqual([THIS.createdAt]);
  });

  it("keeps the newest 50 and marks the list cut", async () => {
    const many = Array.from({ length: 60 }, (_, i) => commit(60 - i));
    const r = await releaseNotesFor(APP, "dpl_x", deps({ compare: async () => ({ ok: true, data: { commits: many, total: 300 } }) }));
    expect(r.ok && r.data.commits).toHaveLength(50);
    expect(r.ok && r.data.commits[0].title).toBe("change 60");
    expect(r.ok && r.data.cut).toBe(true);
    expect(r.ok && r.data.total).toBe(300);
  });

  it("says so for the first deployment, one without a commit, and a redeploy", async () => {
    const first = await releaseNotesFor(APP, "dpl_x", deps({ previous: async () => null }));
    expect(first).toEqual({ ok: true, data: { from: null, to: THIS.commitSha, commits: [], total: 0, cut: false, note: "This is the first production deployment the console has seen." } });
    const cli = await releaseNotesFor(APP, "dpl_x", deps({ deployment: async () => ({ commitSha: null, createdAt: THIS.createdAt }) }));
    expect(cli.ok && cli.data.note).toBe("This deployment wasn't built from a Git commit.");
    const again = await releaseNotesFor(APP, "dpl_x", deps({ previous: async () => ({ commitSha: THIS.commitSha }) }));
    expect(again.ok && again.data.note).toBe("Same commit as the previous production deployment (a redeploy).");
    expect(again.ok && again.data.commits).toEqual([]);
  });

  it("explains a compare GitHub can't do, a missing link and an unknown deployment", async () => {
    expect(await releaseNotesFor(APP, "dpl_x", deps({ compare: async () => ({ ok: false, kind: "missing", error: "not found" }) })))
      .toEqual({ ok: false, error: "GitHub can't compare these commits (the history may have been rewritten)." });
    expect(await releaseNotesFor(APP, "dpl_x", deps({ repo: async () => null }))).toEqual({ ok: false, error: "Link a repository to see what changed." });
    expect(await releaseNotesFor(APP, "dpl_x", deps({ deployment: async () => null }))).toEqual({ ok: false, error: "That deployment isn't a production deployment of this app." });
  });
});
