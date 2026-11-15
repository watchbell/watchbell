import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ switchWorkspace: vi.fn(), dismissUnsortedAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { WorkspacesView } from "./workspaces-view";

const K = { id: "00000000-0000-4000-8000-0000000000b1", name: "Kopi Senja", worst: "down" as const, apps: 3, monitorsDown: 1, openAlerts: 2, lastDeployAt: new Date("2026-11-14T03:00:00Z") };
const N = { id: "00000000-0000-4000-8000-0000000000b2", name: "Northwind Studio", worst: "ok" as const, apps: 1, monitorsDown: 0, openAlerts: 0, lastDeployAt: null };

// Watchbell 1.8 (spec §5): which client has a problem, at a glance; one click opens it.
describe("WorkspacesView (All workspaces)", () => {
  it("lists each workspace with its worst state and counts, worst first", () => {
    const out = renderToStaticMarkup(h(WorkspacesView, { workspaces: [N, K], install: { openAlerts: 0 }, now: new Date("2026-11-15T03:00:00Z").getTime() }));
    expect(out.indexOf("Kopi Senja")).toBeLessThan(out.indexOf("Northwind Studio"));
    expect(out).toContain("1 monitor down");
    expect(out).toContain("2 open alerts");
    expect(out).toContain("All up");
    expect(out).toContain("3 apps");
    expect(out).toContain('aria-label="Open Kopi Senja"');
    expect(out).not.toContain("Install");
  });

  it("names the install's own alerts once, above the workspaces", () => {
    const out = renderToStaticMarkup(h(WorkspacesView, { workspaces: [K], install: { openAlerts: 1 }, now: Date.now() }));
    expect(out).toContain("1 open alert about this install");
    expect(out.indexOf("about this install")).toBeLessThan(out.indexOf("Kopi Senja"));
  });
});

describe("WorkspacesView: not sorted yet (1.8)", () => {
  it("lists the new things waiting in the default workspace, with a way to leave them there", () => {
    const unsorted = [{ id: "r1", name: "new-shop", kind: "app", firstSeenAt: new Date("2026-11-14T03:00:00Z") }];
    const out = renderToStaticMarkup(h(WorkspacesView, { workspaces: [K, N], install: { openAlerts: 0 }, now: Date.now(), unsorted, defaultName: "Personal", canEdit: true }));
    expect(out).toContain('id="unsorted"');
    expect(out).toContain("new-shop");
    expect(out).toContain("Leave in Personal");
    expect(renderToStaticMarkup(h(WorkspacesView, { workspaces: [K, N], install: { openAlerts: 0 }, now: Date.now(), unsorted, defaultName: "Personal", canEdit: false }))).not.toContain("Leave in Personal");
  });
});
