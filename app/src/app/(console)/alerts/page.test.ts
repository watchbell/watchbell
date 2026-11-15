import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const alert = (id: string, title: string) => ({ id, title, message: "", causedBy: null, resourceId: null, ruleKey: "MonitorDown", subject: "m", severity: "critical", startedAt: new Date(), resolvedAt: null });
const h = vi.hoisted(() => ({ ws: { id: null as string | null, list: [] as { id: string; name: string; position: number }[] } }));

vi.mock("@/lib/auth", () => ({ requirePageMember: async () => ({ id: "m", userId: "u", email: "o@example.com", role: "owner" }) }));
vi.mock("@/lib/data/alerts-db", () => ({
  listFiring: async () => [alert("a1", "kopi down"), alert("b1", "north down"), alert("i1", "collector stale")],
  listResolved: async () => [], readMessageTemplates: async () => ({}), rulesWithState: async () => [],
}));
vi.mock("@/lib/data/cached", () => ({ aliasBook: async () => ({ db: new Map(), zone: new Map() }) }));
vi.mock("@/lib/data/notify-db", () => ({ channelViews: async () => [] }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => new Set() }));
vi.mock("@/lib/notify/lang", () => ({ readNotifyLangs: async () => ({ telegram: "en", discord: "en", email: "en" }) }));
vi.mock("@/lib/extensions", () => ({ extensions: {} }));
vi.mock("@/lib/view/display-name", async (orig) => ({ ...(await orig<typeof import("@/lib/view/display-name")>()), hideAlert: (a: { title: string }) => a }));
vi.mock("@/components/live", () => ({ AutoRefresh: () => null }));
vi.mock("./channels-card", () => ({ ChannelsCard: () => null }));
vi.mock("./rules-table", () => ({ RulesTable: () => null }));
vi.mock("./firing-table", () => ({
  FiringTable: ({ rows }: { rows: { title: string }[] }) => rows.map((r) => `[${r.title}]`).join(""),
  ResolvedTable: () => null,
}));
vi.mock("@/lib/workspace/current", () => ({ currentWorkspace: async () => h.ws }));
vi.mock("@/lib/data/workspace-db", () => ({ alertWorkspaceIds: async () => new Map([["a1", A], ["b1", B]]) }));

import AlertsPage from "./page";

const list = [{ id: A, name: "Kopi Senja", position: 0 }, { id: B, name: "Northwind", position: 1 }];
const render = async () => renderToStaticMarkup(await AlertsPage());

beforeEach(() => {
  h.ws = { id: null, list };
});

// Watchbell 1.8 (spec §5): the Alerts page is the chosen workspace's (and the install's own alerts); it says how many
// are open elsewhere, so it never silently disagrees with the bell.
describe("AlertsPage with workspaces", () => {
  it("shows the chosen workspace's alerts and the install's, and counts the others", async () => {
    h.ws = { id: A, list };
    const out = await render();
    expect(out).toContain("[kopi down]");
    expect(out).toContain("[collector stale]");
    expect(out).not.toContain("north down");
    expect(out).toContain("1 more open in other workspaces");
  });

  it("names each alert's workspace when showing all of them", async () => {
    const out = await render();
    expect(out).toContain("[[Kopi Senja] kopi down]");
    expect(out).toContain("[[Northwind] north down]");
    expect(out).toContain("[[Install] collector stale]");
    expect(out).not.toContain("other workspaces");
  });
});
