import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { domainConflictSet, domainInsert } from "@/lib/collector/network";

// Watchbell 1.8 (spec §5, Review Focus 2 and 4): where new things land.

describe("a domain lands with its app (Review Focus 4)", () => {
  const app = { id: "app-1", externalId: "prj_1", workspaceId: "ws-kopi" };
  const now = new Date("2026-11-15T03:00:00Z");
  it("is inserted in the app's workspace, and follows it when the domain moves to another app", () => {
    const d = { name: "shop.example", redirect: null, verified: true };
    expect(domainInsert(app, d, "acc-1", now)).toMatchObject({ kind: "domain", parentId: "app-1", workspaceId: "ws-kopi" });
    expect(domainConflictSet(app, now)).toMatchObject({ parentId: "app-1", workspaceId: "ws-kopi" });
  });
});

// Review Focus 2: a Sync or collector upsert never puts a moved resource back in the default workspace. The only
// upsert allowed to write workspace_id is the domain's (a child follows its app); every other write of resources in the
// collector and Sync leaves it alone.
describe("an upsert keeps the workspace (Review Focus 2)", () => {
  it("no collector or Sync write of resources sets workspaceId, except a domain following its app", () => {
    const root = join(process.cwd(), "src", "lib");
    const files = [join(root, "sync-db.ts"), ...readdirSync(join(root, "collector")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(root, "collector", f))];
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!/workspaceId/.test(src)) return false;
      return !f.endsWith(join("collector", "network.ts"));
    });
    expect(offenders).toEqual([]);
  });
});
