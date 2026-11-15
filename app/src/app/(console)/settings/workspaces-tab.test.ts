import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(console)/workspaces/actions", () => ({
  createWorkspaceAction: vi.fn(), renameWorkspaceAction: vi.fn(), reorderWorkspacesAction: vi.fn(), deleteWorkspaceAction: vi.fn(), setDefaultWorkspaceAction: vi.fn(),
}));

import { WorkspacesTab } from "./workspaces-tab";

const P = { id: "00000000-0000-4000-8000-00000000f001", name: "Personal", position: 0 };
const K = { id: "00000000-0000-4000-8000-0000000000b1", name: "Kopi Senja", position: 1 };

// Watchbell 1.8 (spec §5): the owner's list of workspaces.
describe("WorkspacesTab", () => {
  it("lists the workspaces, marks the default and lets a new one be added", () => {
    const out = renderToStaticMarkup(h(WorkspacesTab, { list: [P, K], defaultId: P.id }));
    expect(out).toContain("Personal");
    expect(out).toContain("Kopi Senja");
    expect(out).toContain("Default");
    expect(out).toContain("New workspace");
    expect(out).toMatch(/new apps, databases and domains land/i);
  });

  it("never offers to delete the default workspace", () => {
    const out = renderToStaticMarkup(h(WorkspacesTab, { list: [P, K], defaultId: P.id }));
    expect(out).not.toContain('aria-label="Delete Personal"');
    expect(out).toContain('aria-label="Delete Kopi Senja"');
    expect(out).not.toContain('aria-label="Make Personal the default"');
  });
});
