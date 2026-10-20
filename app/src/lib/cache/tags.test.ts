import { describe, expect, it } from "vitest";
import { ALL_TAGS, CACHE_SECONDS, CACHE_VERSION, cacheBuildKey, DB_TAGS, pack, tagsForTasks, unpack } from "./tags";

describe("cache tags (perf P3)", () => {
  it("keeps cached reads for at most 5 minutes", () => {
    expect(CACHE_SECONDS).toBe(300);
  });
  it("names one tag per slow-changing area", () => {
    expect(ALL_TAGS).toEqual(["db:supabase", "db:neon", "db:firebase", "db:extra", "net:zones", "net:domains", "status"]);
    expect(DB_TAGS).toEqual({
      supabase_project: "db:supabase", neon_project: "db:neon", firestore: "db:firebase",
      turso_database: "db:extra", upstash_redis: "db:extra", d1_database: "db:extra",
    });
    expect(tagsForTasks(["extraDbs"])).toEqual(["db:extra"]);
  });
  it("maps each collector task to the cached data it writes", () => {
    expect(tagsForTasks(["supabase"])).toEqual(["db:supabase"]);
    expect(tagsForTasks(["supabaseUsage", "neon"])).toEqual(["db:supabase", "db:neon"]);
    expect(tagsForTasks(["firebase", "firebaseUsage"])).toEqual(["db:firebase"]);
    expect(tagsForTasks(["cloudflare"])).toEqual(["net:zones", "net:domains"]);
    // Every network task is followed by refreshNetworkStates, which rewrites zone AND domain states (review m1).
    expect(tagsForTasks(["domains"])).toEqual(["net:zones", "net:domains"]);
    expect(tagsForTasks(["tls"])).toEqual(["net:zones", "net:domains"]);
    expect(tagsForTasks(["eol"])).toEqual(["net:zones", "net:domains"]);
    expect(tagsForTasks(["rdap"])).toEqual(["net:zones", "net:domains"]);
    expect(tagsForTasks(["status"])).toEqual(["status"]);
  });
  it("tasks that only touch real-time data (checks, Vercel, logs, page views, alerts, digest) invalidate nothing", () => {
    expect(tagsForTasks(["checks", "vercel", "logs", "pageviews", "alerts", "digest"])).toEqual([]);
  });
});

describe("cacheBuildKey (review I1): entries never outlive the deployment or the shape they were written by", () => {
  it("uses Vercel's deployment id first, then the commit, then Next's deployment id, then 'local', with the shape version", () => {
    expect(cacheBuildKey({ VERCEL_DEPLOYMENT_ID: "dpl_7J13Nabc", VERCEL_GIT_COMMIT_SHA: "c8202c1" })).toBe(`dpl_7J13Nabc.v${CACHE_VERSION}`);
    expect(cacheBuildKey({ VERCEL_GIT_COMMIT_SHA: "c8202c1aa" })).toBe(`c8202c1aa.v${CACHE_VERSION}`);
    expect(cacheBuildKey({ NEXT_DEPLOYMENT_ID: "demo-3" })).toBe(`demo-3.v${CACHE_VERSION}`);
    expect(cacheBuildKey({})).toBe(`local.v${CACHE_VERSION}`);
    expect(cacheBuildKey({ VERCEL_DEPLOYMENT_ID: "" })).toBe(`local.v${CACHE_VERSION}`);
  });
  it("never lets anything shaped like a URL, host or secret into the key", () => {
    for (const bad of ["postgres://u:p@db.example.com:5432/x", "a b", "x".repeat(65), "db.example.com/x"]) {
      expect(cacheBuildKey({ VERCEL_DEPLOYMENT_ID: bad })).toBe(`local.v${CACHE_VERSION}`);
    }
  });
});

describe("pack / unpack: what goes into the shared cache", () => {
  it("brings Dates back as Dates after the JSON round trip, nested anywhere", () => {
    const v = { at: new Date("2026-10-13T01:00:00Z"), list: [{ since: new Date("2026-10-12T00:00:00Z"), n: 1 }], none: null, s: "x" };
    const back = unpack<typeof v>(JSON.parse(JSON.stringify(pack(v))));
    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.toISOString()).toBe("2026-10-13T01:00:00.000Z");
    expect(back.list[0].since).toBeInstanceOf(Date);
    expect(back).toEqual(v);
  });
  it("keeps Maps too, and plain values as they are", () => {
    const v = { m: new Map([["a", { at: new Date(0) }]]), arr: [1, "two", true] };
    const back = unpack<typeof v>(JSON.parse(JSON.stringify(pack(v))));
    expect(back.m).toBeInstanceOf(Map);
    expect(back.m.get("a")?.at).toEqual(new Date(0));
    expect(back.arr).toEqual([1, "two", true]);
    expect(unpack(pack(null))).toBeNull();
  });
});
