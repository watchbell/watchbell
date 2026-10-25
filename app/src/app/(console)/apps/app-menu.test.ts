import { describe, expect, it, vi } from "vitest";

vi.mock("../monitor-actions", () => ({ pauseAppMonitors: vi.fn() }));
vi.mock("../vercel-actions", () => ({ redeployCurrentAction: vi.fn() }));

import type { MenuEntry } from "@/components/row-menu";
import { appMenuItems, appLogsHref } from "./app-menu";

type Item = Exclude<MenuEntry, "---">;
const app = { id: "a1", name: "shop", siteUrl: "https://shop.example.com", paused: false, monitorCount: 1 };
const handlers = () => ({ redeploy: vi.fn(), viewLogs: vi.fn(), togglePause: vi.fn() });
const byLabel = (items: MenuEntry[], label: string) => items.find((i): i is Item => i !== "---" && i.label === label);

describe("Applications row menu (1.2.1: no 'Arrives in stage N')", () => {
  it("Redeploy and View logs are live items, never 'later'", () => {
    const h = handlers();
    const items = appMenuItems(app, h);
    for (const label of ["Redeploy", "View logs"]) {
      const item = byLabel(items, label);
      expect(item, label).toBeDefined();
      expect(item!.disabled).toBeUndefined();
    }
    byLabel(items, "Redeploy")!.onSelect!();
    expect(h.redeploy).toHaveBeenCalledOnce();
    byLabel(items, "View logs")!.onSelect!();
    expect(h.viewLogs).toHaveBeenCalledOnce();
  });

  it("keeps Open site and Pause/Resume monitors as before", () => {
    const h = handlers();
    const items = appMenuItems(app, h);
    expect(byLabel(items, "Open site")?.href).toBe("https://shop.example.com");
    byLabel(items, "Pause monitors")!.onSelect!();
    expect(h.togglePause).toHaveBeenCalledOnce();
    expect(byLabel(appMenuItems({ ...app, paused: true }, h), "Resume monitors")).toBeDefined();
    expect(byLabel(appMenuItems({ ...app, monitorCount: 0, siteUrl: null }, h), "Pause monitors")).toBeUndefined();
    expect(byLabel(appMenuItems({ ...app, monitorCount: 0, siteUrl: null }, h), "Open site")).toBeUndefined();
  });

  it("View logs opens the app page's Logs tab", () => {
    expect(appLogsHref("a1")).toBe("/apps/a1?tab=logs");
  });
});
