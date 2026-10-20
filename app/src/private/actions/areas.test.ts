import { describe, expect, it } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { AREA_LABELS, areaForAlert, proposedBy } from "./areas";

describe("areaForAlert", () => {
  it("places catalog rules in their area", () => {
    expect(areaForAlert({ ruleKey: "CertExpiringSoon", resourceKind: "domain" })).toBe("network");
    expect(areaForAlert({ ruleKey: "DatabasePaused", resourceKind: "supabase_project" })).toBe("databases");
    expect(areaForAlert({ ruleKey: "CollectorStale", resourceKind: null })).toBe("observe");
    expect(areaForAlert({ ruleKey: "MonitorDown", resourceKind: "app" })).toBe("workloads");
  });
});

describe("area labels", () => {
  it("proposedBy names the officer of an area", () => {
    expect(proposedBy("workloads")).toBe(ACTIONS_COPY.proposedBy("Workloads")); // the edition words it (edition.extras.test.ts)
  });
  it("labels every area with its sidebar group", () => {
    expect(AREA_LABELS).toEqual({ workloads: "Workloads", databases: "Databases", network: "Network", observe: "Observe", ai: "AI & API", admin: "Administration" });
  });
});
