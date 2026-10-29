import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../vercel-actions", () => ({ releaseNotesAction: vi.fn() }));

import type { Commit } from "@/lib/providers/github-browse";
import { DEMO_RELEASE_NOTES } from "@/lib/view/release-notes";
import { ReleaseNotesBody } from "./release-notes-drawer";

const NOW = new Date("2026-10-29T03:00:00Z");
const commit = (over: Partial<Commit>): Commit => ({ sha: "c".repeat(40), title: "change", author: "me", at: "2026-10-29T02:30:00Z", url: "https://github.com/acme/shop/commit/ccc", ...over });

describe("ReleaseNotesBody (1.3 What changed)", () => {
  it("lists each commit with its short SHA, author and time, newest first", () => {
    const html = renderToStaticMarkup(h(ReleaseNotesBody, { notes: DEMO_RELEASE_NOTES, now: NOW }));
    expect(html).toContain("3 commits");
    expect(html).toContain("Show the order total in the receipt email (#42)");
    expect(html).toContain("9b8a7f6");
    expect(html).toContain("orbit-dev");
    expect(html.indexOf("receipt email")).toBeLessThan(html.indexOf("Retry the payment webhook"));
  });

  it("links #N to the pull request when the title names one, else the SHA to the commit", () => {
    const notes = { ...DEMO_RELEASE_NOTES, commits: [commit({ title: "Fix login (#12)" }), commit({ sha: "d".repeat(40), title: "chore", url: "https://github.com/acme/shop/commit/ddd" })], total: 2 };
    const html = renderToStaticMarkup(h(ReleaseNotesBody, { notes, now: NOW }));
    expect(html).toContain('href="https://github.com/acme/shop/pull/12"');
    expect(html).toContain(">#12<");
    expect(html).toContain('href="https://github.com/acme/shop/commit/ddd"');
  });

  it("shows the note instead of a list, and how many more when the list is cut", () => {
    const first = renderToStaticMarkup(h(ReleaseNotesBody, { notes: { from: null, to: "b".repeat(40), commits: [], total: 0, cut: false, note: "This is the first production deployment the console has seen." }, now: NOW }));
    expect(first).toContain("This is the first production deployment the console has seen.");
    expect(first).not.toContain("commits");
    const cut = renderToStaticMarkup(h(ReleaseNotesBody, { notes: { ...DEMO_RELEASE_NOTES, total: 53, cut: true }, now: NOW }));
    expect(cut).toContain("+50 more");
  });
});
