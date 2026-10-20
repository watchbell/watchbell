import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPS } from "@/private/openapi/operations";
import * as route from "./route";

const BODY = { error: { type: "not_found", message: "No such endpoint. See /api/v1/openapi.json." } };

describe("unknown /api/v1 paths", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("%s answers 404 JSON, no redirect, never cached", async (m) => {
    const r = await route[m]();
    expect(r.status).toBe(404);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual(BODY);
  });
  it("HEAD answers 404 too", async () => {
    expect((await route.HEAD()).status).toBe(404);
  });

  // The catch-all only takes what no route file serves: every documented /api/v1 endpoint keeps its own route.ts
  // (a static segment, which Next matches first).
  it("leaves every documented /api/v1 endpoint to its own route", () => {
    const v1 = join(__dirname, "..");
    const paths = OPS.filter((o) => o.path.startsWith("/api/v1/")).map((o) => o.path.slice("/api/v1/".length));
    expect(paths.length).toBeGreaterThanOrEqual(8);
    for (const p of paths) {
      const dir = p.split("/").map((s) => s.replace(/^\{(\w+)\}$/, "[$1]")).join("/");
      expect(existsSync(join(v1, dir, "route.ts")), p).toBe(true);
    }
  });
});
