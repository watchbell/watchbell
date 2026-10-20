import { describe, expect, it } from "vitest";
import { dbOptionFrom } from "./option";

describe("dbOptionFrom", () => {
  it("shows a Supabase project's region and ref", () => {
    expect(dbOptionFrom({ id: "d1", name: "ticketer", kind: "supabase_project", account: "utama", externalId: "abcdefgh", data: { region: "ap-southeast-1" } }))
      .toMatchObject({ id: "d1", region: "ap-southeast-1", ident: "ref abcdefgh" });
  });
  it("shows a Neon project's region, the endpoint on the default branch and the project id", () => {
    const data = {
      region: "aws-ap-southeast-1",
      branches: [{ id: "br-a", name: "dev", isDefault: false, logicalSize: null }, { id: "br-b", name: "main", isDefault: true, logicalSize: null }],
      endpoints: [
        { id: "ep-dev-1", branchId: "br-a", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 1, lastActive: null },
        { id: "ep-main-2", branchId: "br-b", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 1, lastActive: null },
      ],
    };
    expect(dbOptionFrom({ id: "d2", name: "ticketer", kind: "neon_project", account: "kedua", externalId: "muddy-fog-123", data }))
      .toMatchObject({ region: "aws-ap-southeast-1", ident: "ep-main-2 · project muddy-fog-123" });
  });
  it("falls back to the first endpoint, then to the project id alone", () => {
    const ep = { id: "ep-x", branchId: "br-z", state: "idle", pendingState: null, disabled: false, minCu: 1, maxCu: 1, lastActive: null };
    expect(dbOptionFrom({ id: "d", name: "n", kind: "neon_project", account: "a", externalId: "p1", data: { endpoints: [ep] } }).ident).toBe("ep-x · project p1");
    expect(dbOptionFrom({ id: "d", name: "n", kind: "neon_project", account: "a", externalId: "p1", data: null }))
      .toMatchObject({ region: null, ident: "project p1" });
  });
  it("shows a Firestore database's Firebase project id and no region", () => {
    expect(dbOptionFrom({ id: "d3", name: "ticketer", kind: "firestore", account: "a", externalId: "my-proj-1", data: {} }))
      .toMatchObject({ region: null, ident: "project my-proj-1" });
  });
});
