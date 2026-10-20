import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extension } from "@/lib/extensions";

// Settings with and without the private edition's VM runner (registry r1): the open source edition (no runner) shows
// the GitHub Actions lockfile card as a core tab of its own; the private edition keeps its Runner tab, in the same
// place as before (after Status page, before the other extension tabs), and that tab carries the card instead.
const ext = vi.hoisted(() => ({ extensions: { nav: [], palette: [] } as Extension }));
vi.mock("@/lib/extensions", () => ext);
vi.mock("@/lib/auth", () => ({ pageGate: async () => ({ ok: true, member: { id: "m", userId: "u", role: "owner" } }), requireActionMember: vi.fn() }));
vi.mock("@/lib/data/public-status-db", () => ({ statusPageSettings: async () => ({}) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://watchpost.test" }) }));
vi.mock("./collector-tab", () => ({ CollectorTab: () => "[collector]" }));
vi.mock("./budget-tab", () => ({ BudgetTab: () => "[budget]" }));
vi.mock("./users-tab", () => ({ UsersTab: () => "[users]" }));
vi.mock("./retention-tab", () => ({ RetentionTab: () => "[retention]" }));
vi.mock("./status-page-tab", () => ({ StatusPageTab: () => "[status-page]" }));
vi.mock("./actions-lockfile-card", () => ({ ActionsLockfileCard: () => "[actions-lockfile-card]" }));

import SettingsPage from "./page";

const render = async (tab?: string) => renderToStaticMarkup(h("div", null, await SettingsPage({ searchParams: Promise.resolve({ tab }) })));
// The tab triggers' labels, in order.
const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

const RunnerTab = () => "[runner-tab]";
const AutoRunTab = () => "[auto-run-tab]";
const runner = { queueLockfileJob: vi.fn(), lockfileJobActive: vi.fn() };

beforeEach(() => {
  ext.extensions = { nav: [], palette: [] };
});

describe("Settings and the runner extension", () => {
  it("without a runner (open source edition): no Runner tab; the GitHub Actions lockfile card is its own tab", async () => {
    ext.extensions = { nav: [], palette: [], settingsTabs: [{ key: "office-auto-run", label: "Auto-actions", Tab: AutoRunTab }] };
    expect(tabs(await render())).toEqual(["Collector", "Free tier budget", "Users", "Retention", "Status page", "Lockfile", "Auto-actions"]);
    const html = await render("lockfile");
    expect(html).toContain("[actions-lockfile-card]");
    expect(html).not.toContain("Runner");
  });

  it("with the runner (private edition): the Runner tab in its old place, carrying the card; no core Lockfile tab", async () => {
    ext.extensions = {
      nav: [], palette: [], runner,
      settingsTabs: [{ key: "runner", label: "Runner", Tab: RunnerTab }, { key: "office-auto-run", label: "Auto-actions", Tab: AutoRunTab }],
    };
    expect(tabs(await render())).toEqual(["Collector", "Free tier budget", "Users", "Retention", "Status page", "Runner", "Auto-actions"]);
    expect(await render("runner")).toContain("[runner-tab]");
    // ?tab=lockfile is not a tab here: the default (Users) opens.
    const html = await render("lockfile");
    expect(html).not.toContain("[actions-lockfile-card]");
    expect(html).toContain("[users]");
  });
});
