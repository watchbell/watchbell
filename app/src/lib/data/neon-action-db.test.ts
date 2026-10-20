import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { wakeScope } from "./neon-action-db";

const PROJECT = "123e4567-e89b-42d3-a456-426614174000";
const BRANCH = "223e4567-e89b-42d3-a456-426614174000";
const snap = { data: { computeSeconds: 148_320, periodEnd: "2026-11-01T00:00:00Z", endpoints: [] } };

beforeEach(() => {
  h.current = null;
});

describe("wakeScope", () => {
  it("reads nothing for an id that isn't a uuid", async () => {
    const f = fakeDb([]);
    h.current = f;
    expect(await wakeScope("nope")).toBeNull();
    expect(f.queries).toHaveLength(0);
  });

  it("answers null for an unknown or gone row, without reading a snapshot", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    expect(await wakeScope(PROJECT)).toBeNull();
    expect(f.queries).toHaveLength(1);
  });

  it("returns a project's own id and this period's CU seconds from its snapshot", async () => {
    h.current = fakeDb([[{ id: PROJECT, kind: "neon_project", externalId: "ticketer-id", parentId: null }], [snap]]);
    expect(await wakeScope(PROJECT)).toEqual({ projectResourceId: PROJECT, branchExternalId: null, computeSeconds: 148_320, periodEnd: "2026-11-01T00:00:00Z" });
  });

  it("resolves a watched branch to its parent project and keeps the branch id", async () => {
    h.current = fakeDb([[{ id: BRANCH, kind: "neon_branch", externalId: "br-dev", parentId: PROJECT }], [snap]]);
    expect(await wakeScope(BRANCH)).toEqual({ projectResourceId: PROJECT, branchExternalId: "br-dev", computeSeconds: 148_320, periodEnd: "2026-11-01T00:00:00Z" });
  });

  it("answers null for a branch without a parent project", async () => {
    h.current = fakeDb([[{ id: BRANCH, kind: "neon_branch", externalId: "br-dev", parentId: null }]]);
    expect(await wakeScope(BRANCH)).toBeNull();
  });

  it("copes with a project that has no snapshot yet", async () => {
    h.current = fakeDb([[{ id: PROJECT, kind: "neon_project", externalId: "ticketer-id", parentId: null }], []]);
    expect(await wakeScope(PROJECT)).toEqual({ projectResourceId: PROJECT, branchExternalId: null, computeSeconds: null, periodEnd: null });
  });
});
