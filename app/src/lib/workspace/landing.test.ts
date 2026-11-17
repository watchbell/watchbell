import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { domainConflictSet, domainInsert } from "@/lib/collector/network";

// Watchbell 1.8 (spec §5, Review Focus 2 and 4): where new things land.

describe("a domain lands with its app (Review Focus 4)", () => {
  const app = { id: "app-1", externalId: "prj_1", workspaceId: "ws-kopi" };
  const now = new Date("2026-11-15T03:00:00Z");
  // 1.8.3 (1.8.0 deferred minor): the task reads the apps once at its start; an app moved to another workspace while
  // the run waits on Vercel had its domains written back to the old one. The workspace is read from the app's row when
  // the domain is written (the start-of-run value only if that row is gone).
  const render = (q: unknown) => new PgDialect().sqlToQuery(q as Parameters<PgDialect["sqlToQuery"]>[0]);
  it("is written to the app's workspace as it is at write time, following it when the domain moves to another app", () => {
    const d = { name: "shop.example", redirect: null, verified: true };
    const ins = domainInsert(app, d, "acc-1", now);
    expect(ins).toMatchObject({ kind: "domain", parentId: "app-1" });
    const set = domainConflictSet(app, now);
    expect(set).toMatchObject({ parentId: "app-1" });
    for (const ws of [ins.workspaceId, set.workspaceId]) {
      const q = render(ws);
      expect(q.sql).toMatch(/coalesce\(\(select .*workspace_id.* from .*resources.* where .*id.* = \$1\), \$2\)/i);
      expect(q.params).toEqual(["app-1", "ws-kopi"]);
    }
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
