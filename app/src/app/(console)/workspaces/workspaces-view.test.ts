import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ switchWorkspace: vi.fn(), dismissUnsortedAction: vi.fn(), moveToWorkspace: vi.fn() }));
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

// 1.8.1 (owner, 15 Nov): move a new thing straight from the note, to any other workspace, with a visible
// "Moving to <workspace>…" while it runs; and a row whose only problem is a degraded app says so.
describe("WorkspacesView 1.8.1", () => {
  const unsorted = [{ id: "r1", name: "ticketing-demo", kind: "app", firstSeenAt: new Date("2026-11-12T03:18:00Z") }];
  const P = { id: "00000000-0000-4000-8000-00000000f001", name: "Personal" };
  const T = { id: "00000000-0000-4000-8000-0000000000c3", name: "test" };
  const view = (canEdit: boolean) => renderToStaticMarkup(h(WorkspacesView, {
    workspaces: [{ ...N, id: P.id, name: P.name }], install: { openAlerts: 0 }, now: Date.now(), unsorted, defaultName: "Personal", canEdit,
    targets: [T],
  }));

  it("offers Move to… on each not-sorted item for editors", () => {
    expect(view(true)).toContain('aria-label="Move ticketing-demo to another workspace"');
    expect(view(false)).not.toContain("Move ticketing-demo");
  });

  it("names a degraded or down app in the row instead of leaving it blank", () => {
    const W = { ...N, worst: "warn" as const, appsWarn: 1, appsDown: 0 };
    expect(renderToStaticMarkup(h(WorkspacesView, { workspaces: [W], install: { openAlerts: 0 }, now: Date.now() }))).toContain("1 app degraded");
    const D = { ...N, worst: "down" as const, appsWarn: 0, appsDown: 2 };
    expect(renderToStaticMarkup(h(WorkspacesView, { workspaces: [D], install: { openAlerts: 0 }, now: Date.now() }))).toContain("2 apps down");
  });
});

