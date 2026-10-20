import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ listDnsRecords: vi.fn(), mergeSnapshot: vi.fn(), refreshNetworkStates: vi.fn(), updateTags: vi.fn() }));
vi.mock("@/lib/providers/cloudflare", () => ({ listDnsRecords: h.listDnsRecords }));
vi.mock("@/lib/data/snapshots-db", () => ({ mergeSnapshot: h.mergeSnapshot }));
vi.mock("@/lib/collector/network", () => ({ refreshNetworkStates: h.refreshNetworkStates }));
vi.mock("@/lib/cache/invalidate", () => ({ updateTags: h.updateTags }));

import { refreshZoneRecords } from "./zone-refresh";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("refreshZoneRecords", () => {
  it("reads the zone, merges the records into its snapshot, then expires the zone and domain tags", async () => {
    h.listDnsRecords.mockResolvedValue({ ok: true, data: { records: [{ id: "r1" }], truncated: false } });
    expect(await refreshZoneRecords("z1", "tok", "cfzone")).toBe(true);
    expect(h.listDnsRecords).toHaveBeenCalledWith("tok", "cfzone", {});
    expect(h.mergeSnapshot).toHaveBeenCalledWith("z1", { records: [{ id: "r1" }], recordsTruncated: false }, expect.any(Date));
    expect(h.updateTags).toHaveBeenCalledWith(["net:zones", "net:domains"]);
  });
  it("a failed read changes nothing and returns false", async () => {
    h.listDnsRecords.mockResolvedValue({ ok: false, kind: "transient", error: "x" });
    expect(await refreshZoneRecords("z1", "tok", "cfzone")).toBe(false);
    expect(h.mergeSnapshot).not.toHaveBeenCalled();
    expect(h.updateTags).not.toHaveBeenCalled();
  });
  it("a throwing database write is swallowed", async () => {
    h.listDnsRecords.mockResolvedValue({ ok: true, data: { records: [], truncated: false } });
    h.mergeSnapshot.mockRejectedValue(new Error("db down"));
    await expect(refreshZoneRecords("z1", "tok", "cfzone")).resolves.toBe(false);
  });
});
