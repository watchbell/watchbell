import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./source-actions", () => ({ setupSourceAction: vi.fn(), revokeSourceAction: vi.fn(), sendTestAlertAction: vi.fn(), sourceStatusAction: vi.fn() }));
vi.mock("@/components/live", () => ({ useHoldRefresh: () => undefined }));

import { filterBySource } from "@/lib/view/sources";
import { SourcesCard, type SourcesView } from "./sources-card";

const now = new Date("2026-11-25T10:00:00Z");
const view = (o: Partial<SourcesView> = {}): SourcesView => ({
  state: "active", demo: false, owner: true, url: "https://ops.example.com/api/alertmanager/am_8f2k…", lastAlert: new Date("2026-11-25T09:56:00Z"),
  received: 146, refused: 0, recent: [{ title: "HighErrorRate · pos-api", status: "firing", at: new Date("2026-11-25T09:56:00Z") }], now, ...o,
});
const html = (o: Partial<SourcesView> = {}) => renderToStaticMarkup(createElement(SourcesCard, { v: view(o) }));

describe("Alerts › Sources", () => {
  it("offers the owner a set-up when there is no source, and says only the owner can to a viewer", () => {
    expect(html({ state: "none" })).toContain("Set up Alertmanager");
    const viewer = html({ state: "none", owner: false });
    expect(viewer).not.toContain("Set up Alertmanager");
    expect(viewer).toContain("Only the owner can set this up.");
  });

  it("shows an active source's facts, the last alerts received, and the owner's buttons", () => {
    const out = html();
    for (const s of ["active", "https://ops.example.com/api/alertmanager/am_8f2k…", "146 alerts · 0 refused", "120 alerts a minute · 256 KB a call", "HighErrorRate · pos-api", "Replace URL", "Revoke", "Send a test alert", "How alerts map"]) {
      expect(out).toContain(s);
    }
    const viewer = html({ owner: false });
    expect(viewer).toContain("146 alerts · 0 refused");
    expect(viewer).not.toContain("Replace URL");
  });

  it("says when a source has been quiet for 7 days, and when it was revoked", () => {
    expect(html({ state: "quiet" })).toContain("No alerts in 7 days or more");
    const revoked = html({ state: "revoked" });
    expect(revoked).toContain("The webhook URL was revoked");
    expect(revoked).toContain("Set up Alertmanager");
  });

  it("explains the demo can't take alerts and offers nothing to press", () => {
    const out = html({ demo: true, state: "none" });
    expect(out).toContain("Not available in the demo");
    expect(out).not.toContain("Set up Alertmanager");
  });
});

describe("filterBySource", () => {
  const rows = [{ id: "1", ruleKey: "MonitorDown" }, { id: "2", ruleKey: "ExternalAlert" }, { id: "3", ruleKey: "CollectorStale" }];
  it("keeps all, Watchbell's own, or Alertmanager's", () => {
    expect(filterBySource(rows, "all").map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterBySource(rows, "watchbell").map((r) => r.id)).toEqual(["1", "3"]);
    expect(filterBySource(rows, "alertmanager").map((r) => r.id)).toEqual(["2"]);
  });
});
