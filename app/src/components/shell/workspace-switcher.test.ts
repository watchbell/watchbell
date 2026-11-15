import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(console)/workspaces/actions", () => ({ switchWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { WorkspaceSwitcher } from "./workspace-switcher";

const P = { id: "00000000-0000-4000-8000-00000000f001", name: "Personal" };
const K = { id: "00000000-0000-4000-8000-0000000000b1", name: "Kopi Senja" };

// Watchbell 1.8 (spec §5): the sidebar header names the workspace shown and opens the switcher.
describe("WorkspaceSwitcher", () => {
  it("names the current workspace, or All workspaces", () => {
    const out = renderToStaticMarkup(h(WorkspaceSwitcher, { list: [P, K], current: K.id, isOwner: true }));
    expect(out).toContain("Kopi Senja");
    expect(out).toContain('aria-label="Workspace: Kopi Senja. Switch workspace"');
    expect(renderToStaticMarkup(h(WorkspaceSwitcher, { list: [P, K], current: null, isOwner: false }))).toContain("All workspaces");
  });

  it("with one workspace still shows its name (and nothing else changes)", () => {
    expect(renderToStaticMarkup(h(WorkspaceSwitcher, { list: [P], current: P.id, isOwner: true }))).toContain("Personal");
  });
});
