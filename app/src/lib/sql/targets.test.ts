import { describe, expect, it } from "vitest";
import { guardSql } from "./guard";
import { roleSql } from "./role-sql";
import { BUILTIN_SNIPPETS, parseLocalSnippets } from "./snippets";
import { endpointBelongs, needsWakeConfirm, neonWakeState, WAKE_TEXT } from "./targets";

const ep = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, branchId: "br-1", state, pendingState: null, disabled: false, minCu: 0.25, maxCu: 0.25, lastActive: null, ...extra,
});

describe("Neon wake confirmation", () => {
  it("asks when the connection's compute is idle", () => {
    const data = { endpoints: [ep("ep-a", "idle"), ep("ep-b", "active")] };
    expect(neonWakeState(data, "ep-a")).toBe("idle");
    expect(needsWakeConfirm("neon", data, "ep-a")).toBe(true);
    expect(neonWakeState(data, "ep-b")).toBe("active");
    expect(needsWakeConfirm("neon", data, "ep-b")).toBe(false);
  });

  it("asks when the state is unknown: no snapshot, an unlisted endpoint, or a compute starting", () => {
    expect(needsWakeConfirm("neon", null, "ep-a")).toBe(true);
    expect(needsWakeConfirm("neon", { endpoints: [ep("ep-b", "active")] }, "ep-a")).toBe(true);
    expect(neonWakeState({ endpoints: [ep("ep-a", "idle", { pendingState: "active" })] }, "ep-a")).toBe("unknown");
    expect(neonWakeState({ endpoints: [ep("ep-a", "active", { disabled: true })] }, "ep-a")).toBe("unknown");
  });

  it("without an endpoint id, uses every compute of the project", () => {
    expect(neonWakeState({ endpoints: [ep("ep-a", "idle"), ep("ep-b", "idle")] }, null)).toBe("idle");
    expect(neonWakeState({ endpoints: [ep("ep-a", "idle"), ep("ep-b", "active")] }, null)).toBe("active");
  });

  it("never asks for Supabase", () => {
    expect(needsWakeConfirm("supabase", null, null)).toBe(false);
  });

  it("uses the agreed sentence", () => {
    expect(WAKE_TEXT).toBe("Running this will wake the Neon compute (uses CU-hours). Run anyway?");
  });

  it("checks that the endpoint belongs to the project when the snapshot lists them", () => {
    const data = { endpoints: [ep("ep-a", "idle")] };
    expect(endpointBelongs(data, "ep-a")).toBe(true);
    expect(endpointBelongs(data, "ep-z")).toBe(false);
    expect(endpointBelongs({}, "ep-z")).toBe(true);
  });
});

describe("snippets", () => {
  it.each(BUILTIN_SNIPPETS.map((s) => [s.label, s.sql]))("%s passes the guard as a plain SELECT", (_label, sql) => {
    expect(guardSql(sql)).toMatchObject({ ok: true, kind: "select" });
  });

  it("covers the five starter queries", () => {
    expect(BUILTIN_SNIPPETS.map((s) => s.id)).toEqual(["tables-by-size", "active-connections", "slow-queries", "cache-hit-ratio", "row-estimates"]);
  });

  it("reads only well-formed local snippets", () => {
    expect(parseLocalSnippets(null)).toEqual([]);
    expect(parseLocalSnippets("{bad")).toEqual([]);
    expect(parseLocalSnippets(JSON.stringify({ id: "x" }))).toEqual([]);
    expect(parseLocalSnippets(JSON.stringify([{ id: "a", label: "A", sql: "select 1" }, { id: 2, label: "B", sql: "x" }]))).toEqual([{ id: "a", label: "A", sql: "select 1" }]);
  });
});

describe("role SQL", () => {
  it.each(["supabase", "neon"] as const)("gives %s a login role with only CONNECT, USAGE and SELECT", (p) => {
    const sql = roleSql(p).toLowerCase();
    expect(sql).toContain("create role watchpost_ro login password");
    expect(sql).toContain("grant connect on database");
    expect(sql).toContain("grant usage on schema public to watchpost_ro");
    expect(sql).toContain("grant select on all tables in schema public to watchpost_ro");
    expect(sql).toContain("alter default privileges for role");
    expect(sql).toContain("default_transaction_read_only = on");
    expect(sql).not.toMatch(/grant (insert|update|delete|all)/);
  });
});
