import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requirePageMember: vi.fn(), currentWorkspace: vi.fn(), workspaceForEditing: vi.fn(), reportMonitorOptions: vi.fn(), listReports: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requirePageMember: h.requirePageMember }));
vi.mock("@/lib/workspace/current", () => ({ currentWorkspace: h.currentWorkspace, workspaceForEditing: h.workspaceForEditing }));
vi.mock("@/lib/data/report-db", () => ({ listReports: h.listReports, reportMonitorOptions: h.reportMonitorOptions, reportMonths: async () => [] }));
vi.mock("@/lib/data/notify-db", () => ({ readChannel: async () => null }));
vi.mock("@/lib/notify/env", () => ({ notifyEnv: () => ({}) }));
vi.mock("./reports-view", () => ({ ReportsView: () => null }));

import ReportsPage from "./page";

const K = "00000000-0000-4000-8000-0000000000b1";
const P = "00000000-0000-4000-8000-00000000f001";

beforeEach(() => {
  vi.resetAllMocks();
  h.requirePageMember.mockResolvedValue({ id: "m", userId: "u", email: "o@example.com", role: "owner" });
  h.workspaceForEditing.mockResolvedValue(P);
  h.reportMonitorOptions.mockResolvedValue([]);
  h.listReports.mockResolvedValue([]);
});

// 1.8.3 (1.8.0 deferred minor): under All workspaces the editor's website list was the default workspace's only, so a
// report of another client listed none of its own monitors. It follows the workspace shown: all of them under All.
describe("Reports page: the editor's websites", () => {
  it("lists every workspace's monitors under All workspaces", async () => {
    h.currentWorkspace.mockResolvedValue({ id: null, list: [] });
    await ReportsPage();
    expect(h.reportMonitorOptions).toHaveBeenCalledWith(null);
  });
  it("lists the shown workspace's monitors otherwise", async () => {
    h.currentWorkspace.mockResolvedValue({ id: K, list: [] });
    await ReportsPage();
    expect(h.reportMonitorOptions).toHaveBeenCalledWith(K);
  });
});
