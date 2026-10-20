import { afterEach, describe, expect, it } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import { filterLines, levelBucket, readText, toWire, vercelLogsUrl, type WireLine } from "./logs";

const line = (o: Partial<WireLine>): WireLine => ({ id: "r", time: "19:41:07", level: "error", app: "acme-shop", text: "GET /x 500 boom", ...o });

describe("toWire", () => {
  it("shows WIB clock time with seconds and joins method, path, status and message", () => {
    const w = toWire({ id: "r1", at: new Date("2026-10-13T12:41:07Z"), level: "error", app: "acme-shop", method: "GET", path: "/courses", status: 500, message: "Supabase: project is paused" });
    expect(w).toEqual({ id: "r1", time: "19:41:07", level: "error", app: "acme-shop", text: "GET /courses 500 Supabase: project is paused" });
  });
  it("leaves out what the line doesn't have", () => {
    const w = toWire({ id: "r2", at: new Date("2026-10-13T12:41:07Z"), level: "warning", app: "a", method: null, path: null, status: null, message: "slow query" });
    expect(w.text).toBe("slow query");
  });
});

describe("toWire in other zones (1.1)", () => {
  afterEach(() => resetTimeZoneForTests());
  const line = (iso: string) => toWire({ id: "r", at: new Date(iso), level: "info", app: "a", method: null, path: null, status: null, message: "m" });

  it("Asia/Kolkata and Asia/Kathmandu keep the seconds and move the minutes", () => {
    resetTimeZoneForTests("Asia/Kolkata");
    expect(line("2026-10-13T12:41:07Z").time).toBe("18:11:07");
    expect(line("2026-10-13T18:29:59Z").time).toBe("23:59:59");
    resetTimeZoneForTests("Asia/Kathmandu");
    expect(line("2026-10-13T12:41:07Z").time).toBe("18:26:07");
  });

  it("Europe/Berlin follows summer and winter time", () => {
    resetTimeZoneForTests("Europe/Berlin");
    expect(line("2026-10-13T12:41:07Z").time).toBe("14:41:07");
    expect(line("2026-12-13T12:41:07Z").time).toBe("13:41:07");
  });
});

describe("levelBucket", () => {
  it("groups fatal with error and debug or trace with info", () => {
    expect([levelBucket("fatal"), levelBucket("error"), levelBucket("warning"), levelBucket("info"), levelBucket("debug"), levelBucket("trace")])
      .toEqual(["error", "error", "warning", "info", "info", "info"]);
  });
});

describe("filterLines", () => {
  const all = [line({ id: "1", level: "error" }), line({ id: "2", level: "fatal", app: "orbit-blog", text: "GET / 502 FUNCTION_INVOCATION_FAILED" }), line({ id: "3", level: "info", app: "orbit-blog", text: "GET / 200" })];
  it("keeps everything without filters", () => {
    expect(filterLines(all, { app: "", level: "", text: "" })).toHaveLength(3);
  });
  it("filters by app and by level bucket", () => {
    expect(filterLines(all, { app: "orbit-blog", level: "", text: "" }).map((l) => l.id)).toEqual(["2", "3"]);
    expect(filterLines(all, { app: "", level: "error", text: "" }).map((l) => l.id)).toEqual(["1", "2"]);
  });
  it("searches app and text without regard to case", () => {
    expect(filterLines(all, { app: "", level: "", text: "function_invocation" }).map((l) => l.id)).toEqual(["2"]);
    expect(filterLines(all, { app: "", level: "", text: "ACME-SHOP" }).map((l) => l.id)).toEqual(["1"]);
  });
});

describe("readText", () => {
  it("says how long ago the stream was read", () => {
    expect(readText(null, 0)).toBe("reading…");
    expect(readText(1000, 1500)).toBe("read just now");
    expect(readText(1000, 13_000)).toBe("read 12s ago");
    expect(readText(1000, 200_000)).toBe("read 3 min ago");
  });
});

describe("vercelLogsUrl", () => {
  it("points at the project's Logs page, or nothing without a team slug", () => {
    expect(vercelLogsUrl("acme-team", "acme-shop")).toBe("https://vercel.com/acme-team/acme-shop/logs");
    expect(vercelLogsUrl(undefined, "acme-shop")).toBeNull();
    expect(vercelLogsUrl("", "acme-shop")).toBeNull();
  });
});
