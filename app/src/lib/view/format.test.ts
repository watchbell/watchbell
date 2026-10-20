import { describe, expect, it } from "vitest";
import {
  appDomain, commitTitle, createdText, deployDuration, duration, eventTime, forHowLong, hostPath, itemCount, lastDeployText, longDate, msText, pct, rel, shortSha,
} from "./format";

describe("commitTitle (J)", () => {
  it("keeps only the subject line, trimmed, without the body or Co-Authored-By trailers", () => {
    expect(commitTitle("fix(auth): keep sessions  \n\nLonger body.\n\nCo-Authored-By: Someone <a@b.c>")).toBe("fix(auth): keep sessions");
    expect(commitTitle("feat: x\r\n\r\nCo-Authored-By: Someone <a@b.c>")).toBe("feat: x");
    expect(commitTitle("  one line  ")).toBe("one line");
  });
  it("skips blank leading lines, and is empty for no message", () => {
    expect(commitTitle("\n\n  subject\nbody")).toBe("subject");
    expect(commitTitle(null)).toBe("");
    expect(commitTitle(undefined)).toBe("");
    expect(commitTitle("   \n  ")).toBe("");
  });
});

const now = new Date("2026-10-12T10:00:00Z"); // 17:00 WIB
const S = 1000;
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const back = (ms: number) => new Date(now.getTime() - ms);

describe("rel (R6)", () => {
  it("says now under a minute, and for a time in the future", () => {
    expect(rel(back(30 * S), now)).toBe("now");
    expect(rel(back(-5 * M), now)).toBe("now");
  });
  it("counts minutes, hours and days", () => {
    expect(rel(back(5 * M), now)).toBe("5 min ago");
    expect(rel(back(2 * H + 10 * M), now)).toBe("2 h ago");
    expect(rel(back(3 * D + H), now)).toBe("3 d ago");
  });
});

describe("createdText (Deployments → Created)", () => {
  it("is relative for the last hour", () => {
    expect(createdText(back(20 * S), now)).toBe("now");
    expect(createdText(back(12 * M), now)).toBe("12 min ago");
  });
  it("shows the WIB clock for the rest of today", () => {
    expect(createdText(new Date("2026-10-12T05:41:00Z"), now)).toBe("12:41");
  });
  it("counts days before today, at least one", () => {
    expect(createdText(new Date("2026-10-11T16:59:00Z"), now)).toBe("1 d ago"); // 23:59 WIB yesterday
    expect(createdText(back(3 * D), now)).toBe("3 d ago");
  });
});

describe("duration", () => {
  it("formats like the mockup", () => {
    expect(duration(41 * S)).toBe("41s");
    expect(duration(72 * S)).toBe("1m 12s");
    expect(duration(68 * S)).toBe("1m 08s");
    expect(duration(62 * M)).toBe("1h 02m");
    expect(duration(-5)).toBe("0s");
  });
});

describe("deployDuration", () => {
  it("counts elapsed time while building", () => {
    expect(deployDuration({ state: "building", createdAt: back(40 * S), buildingAt: back(38 * S), readyAt: null }, now)).toBe("38s elapsed");
  });
  it("shows the build time once finished", () => {
    expect(deployDuration({ state: "ready", createdAt: back(H), buildingAt: back(H), readyAt: new Date(back(H).getTime() + 72 * S) }, now)).toBe("1m 12s");
  });
  it("shows a dash when Vercel gave no times", () => {
    expect(deployDuration({ state: "error", createdAt: back(H), buildingAt: null, readyAt: null }, now)).toBe("—");
  });
});

describe("lastDeployText (Applications → Last deploy)", () => {
  it("shows a dash for an app with no deployments", () => {
    expect(lastDeployText(null, now)).toBe("—");
  });
  it("is relative for a ready deployment", () => {
    expect(lastDeployText({ state: "ready", createdAt: back(3 * H), buildingAt: null, readyAt: back(2 * H) }, now)).toBe("2 h ago");
  });
  it("reads a deployment from months ago as days (an app that is not redeployed)", () => {
    expect(lastDeployText({ state: "ready", createdAt: back(85 * D + H), buildingAt: null, readyAt: back(85 * D) }, now)).toBe("85 d ago");
  });
  it("shows the build time so far while building", () => {
    expect(lastDeployText({ state: "building", createdAt: back(38 * S), buildingAt: null, readyAt: null }, now)).toBe("building 38s");
  });
  it("shows when it failed: the clock today, relative before", () => {
    expect(lastDeployText({ state: "error", createdAt: new Date("2026-10-12T05:40:00Z"), buildingAt: null, readyAt: new Date("2026-10-12T05:41:00Z") }, now)).toBe("failed 12:41");
    expect(lastDeployText({ state: "error", createdAt: back(3 * D), buildingAt: null, readyAt: null }, now)).toBe("failed 3 d ago");
  });
  it("marks a canceled one", () => {
    expect(lastDeployText({ state: "canceled", createdAt: back(D + H), buildingAt: null, readyAt: null }, now)).toBe("canceled 1 d ago");
  });
});

describe("numbers", () => {
  it("formats percentages, milliseconds and item counts, with a dash for no data", () => {
    expect(pct(99.984)).toBe("99.98%");
    expect(pct(100)).toBe("100.00%");
    expect(pct(null)).toBe("—");
    expect(pct(99.996)).toBe("99.99%");
    expect(pct(99.9977)).toBe("99.99%");
    expect(pct(0)).toBe("0.00%");
    expect(msText(412.4)).toBe("412 ms");
    expect(msText(null)).toBe("—");
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(0)).toBe("0 items");
    expect(itemCount(6)).toBe("6 items");
  });
});

describe("eventTime", () => {
  it("shows the WIB clock today and the day before that", () => {
    expect(eventTime(new Date("2026-10-12T09:30:00Z"), now)).toBe("16:30");
    expect(eventTime(new Date("2026-10-11T12:05:00Z"), now)).toBe("11 Oct 19:05");
    expect(eventTime(new Date("2026-09-11T12:05:00Z"), now)).toBe("11 Sep 19:05");
  });
});

describe("forHowLong", () => {
  it("rounds down to whole minutes, hours or days, at least one minute", () => {
    expect(forHowLong(back(30 * S), now)).toBe("1 minute");
    expect(forHowLong(back(4 * M), now)).toBe("4 minutes");
    expect(forHowLong(back(2 * H + 5 * M), now)).toBe("2 hours");
    expect(forHowLong(back(D + H), now)).toBe("1 day");
  });
});

describe("small helpers", () => {
  it("shortens a commit sha", () => {
    expect(shortSha("c8202c1abcdef")).toBe("c8202c1");
    expect(shortSha(null)).toBe("—");
  });
  it("shows host and path of a URL", () => {
    expect(hostPath("https://example.com/api/health")).toBe("example.com/api/health");
    expect(hostPath("not a url")).toBe("not a url");
  });
  it("formats a creation date like the mockup", () => {
    expect(longDate(new Date("2026-03-14T05:00:00Z"))).toBe("14 Mar 2026");
    expect(longDate(new Date("2026-09-02T05:00:00Z"))).toBe("2 Sep 2026");
  });
  it("takes an app's domain from its oldest monitor, else <name>.vercel.app", () => {
    expect(appDomain("web", ["https://portfolio.example.com/", "https://x.vercel.app/api"])).toBe("portfolio.example.com");
    expect(appDomain("web", [])).toBe("web.vercel.app");
    expect(appDomain("web", ["not a url"])).toBe("web.vercel.app");
    // U3: a heartbeat's url names no domain.
    expect(appDomain("web", ["heartbeat:x", "https://a.example.com/"])).toBe("a.example.com");
    expect(appDomain("web", ["heartbeat:backup-job"])).toBe("web.vercel.app");
  });
});
