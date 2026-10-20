import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLocalDays, ago, calendarDate, clock, clockSeconds, dayKey, dayMonth, dayStart, expires, fromLocalInput, lastSync, resetTimeZoneForTests, sameDay, timeZone,
  toLocalInput, zonedParts, zoneLabel,
  dailyRunText, LEGACY_ZONES, vercelCronText, zonedFormat, zoneProblem,
} from "./time";

const at = (iso: string) => new Date(iso);

describe("WIB helpers", () => {
  it("formats the clock and the day in Asia/Jakarta", () => {
    expect(clock(at("2026-10-12T20:30:00Z"))).toBe("03:30");
    expect(dayMonth(at("2026-10-12T20:30:00Z"))).toBe("13 Oct");
  });

  it("writes September as Sep, not Sept", () => {
    expect(dayMonth(at("2026-09-02T05:00:00Z"))).toBe("2 Sep");
    expect(dayMonth(at("2026-09-30T20:00:00Z"))).toBe("1 Oct"); // 03:00 WIB next day
  });

  it("compares calendar days in WIB, not UTC", () => {
    expect(sameDay(at("2026-10-12T16:00:00Z"), at("2026-10-12T17:30:00Z"))).toBe(false); // 23:00 vs 00:30 WIB
    expect(sameDay(at("2026-10-12T17:30:00Z"), at("2026-10-13T16:00:00Z"))).toBe(true);
  });
});

describe("lastSync", () => {
  const now = at("2026-10-12T10:00:00Z"); // 17:00 WIB
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("says never without a date", () => expect(lastSync(null, now)).toBe("never"));
  it("says just now under a minute", () => expect(lastSync(ago(20_000), now)).toBe("just now"));
  it("counts minutes under an hour", () => expect(lastSync(ago(2 * 60_000), now)).toBe("2 min ago"));
  it("shows today HH:MM for the same WIB day", () => expect(lastSync(at("2026-10-12T02:00:00Z"), now)).toBe("today 09:00"));
  it("shows D MMM HH:MM for older days", () => expect(lastSync(at("2026-10-01T20:30:00Z"), now)).toBe("2 Oct 03:30"));
  it("uses the WIB day boundary for today", () => expect(lastSync(at("2026-10-11T16:59:00Z"), now)).toBe("11 Oct 23:59"));
});

describe("expires", () => {
  const now = at("2026-10-12T10:00:00Z");
  const from = (ms: number) => new Date(now.getTime() + ms);
  const H = 3_600_000;
  it("shows a dash without a date", () => expect(expires(null, now)).toBe("—"));
  it("counts whole days ahead, rounding down", () => expect(expires(from(83 * 24 * H + 23 * H), now)).toBe("in 83 days"));
  it("uses the singular for one day", () => expect(expires(from(30 * H), now)).toBe("in 1 day"));
  it("says today when less than a day is left", () => expect(expires(from(5 * H), now)).toBe("today"));
  it("says expired 1 day ago for anything already past", () => {
    expect(expires(from(-12 * H), now)).toBe("expired 1 day ago");
    expect(expires(from(-30 * H), now)).toBe("expired 1 day ago");
  });
  it("counts whole days past", () => expect(expires(from(-50 * H), now)).toBe("expired 2 days ago"));
});

describe("ago", () => {
  const now = at("2026-10-12T10:00:00Z"); // 17:00 WIB
  const back = (s: number) => new Date(now.getTime() - s * 1000);
  it("clamps a date in the future to 0s", () => expect(ago(back(-30), now)).toBe("0s ago"));
  it("counts seconds under a minute", () => {
    expect(ago(back(0), now)).toBe("0s ago");
    expect(ago(back(59), now)).toBe("59s ago");
  });
  it("counts whole minutes under an hour", () => {
    expect(ago(back(60), now)).toBe("1 min ago");
    expect(ago(back(3599), now)).toBe("59 min ago");
  });
  it("shows today HH:MM in WIB from an hour on", () => expect(ago(back(3600), now)).toBe("today 16:00"));
  it("shows D MMM HH:MM for an earlier WIB day", () => expect(ago(at("2026-10-11T16:59:00Z"), now)).toBe("11 Oct 23:59"));
});

describe("the configured zone (1.1)", () => {
  afterEach(() => {
    resetTimeZoneForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is Asia/Jakarta with the WIB label when nothing is set", () => {
    vi.stubEnv("WATCHBELL_TIMEZONE", "");
    vi.stubEnv("WATCHPOST_TIMEZONE", "");
    resetTimeZoneForTests();
    expect(timeZone()).toBe("Asia/Jakarta");
    expect(zoneLabel()).toBe("WIB");
    expect(zoneLabel(at("2026-07-01T00:00:00Z"))).toBe("WIB");
  });

  it("reads WATCHBELL_TIMEZONE, else the old WATCHPOST_TIMEZONE", () => {
    vi.stubEnv("WATCHBELL_TIMEZONE", "Europe/Berlin");
    resetTimeZoneForTests();
    expect(timeZone()).toBe("Europe/Berlin");
    vi.stubEnv("WATCHBELL_TIMEZONE", "");
    vi.stubEnv("WATCHPOST_TIMEZONE", "America/New_York");
    resetTimeZoneForTests();
    expect(timeZone()).toBe("America/New_York");
  });

  it("falls back to Asia/Jakarta on a typo, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetTimeZoneForTests("Asia/Jakata");
    expect(timeZone()).toBe("Asia/Jakarta");
    expect(timeZone()).toBe("Asia/Jakarta");
    expect(clock(at("2026-10-12T20:30:00Z"))).toBe("03:30");
    expect(zoneLabel()).toBe("WIB");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("WATCHBELL_TIMEZONE=Asia/Jakata");
    expect(String(warn.mock.calls[0][0])).toContain("Using Asia/Jakarta");
  });

  it("labels other zones with Intl's short name, following daylight saving", () => {
    resetTimeZoneForTests("Europe/Berlin");
    expect(zoneLabel(at("2026-01-15T12:00:00Z"))).toBe("CET");
    expect(zoneLabel(at("2026-07-15T12:00:00Z"))).toBe("CEST");
    resetTimeZoneForTests("America/New_York");
    expect(zoneLabel(at("2026-01-15T12:00:00Z"))).toBe("EST");
    expect(zoneLabel(at("2026-07-15T12:00:00Z"))).toBe("EDT");
    resetTimeZoneForTests("Asia/Kolkata");
    expect(zoneLabel(at("2026-01-15T12:00:00Z"))).toBe("GMT+5:30");
    resetTimeZoneForTests("UTC");
    expect(zoneLabel(at("2026-01-15T12:00:00Z"))).toBe("UTC");
  });

  it("keeps the operator's spelling and accepts any case", () => {
    resetTimeZoneForTests("Asia/Kolkata");
    expect(timeZone()).toBe("Asia/Kolkata"); // not Intl's older Asia/Calcutta
    resetTimeZoneForTests(" europe/berlin ");
    expect(timeZone()).toBe("Europe/Berlin");
  });
});

describe("Europe/Berlin daylight saving (29 Mar and 25 Oct 2026)", () => {
  beforeEach(() => resetTimeZoneForTests("Europe/Berlin"));
  afterEach(() => resetTimeZoneForTests());

  it("has a 23-hour day in spring and a 25-hour day in autumn", () => {
    expect(dayStart("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(dayStart("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(dayStart("2026-03-30").getTime() - dayStart("2026-03-29").getTime()).toBe(23 * 3_600_000);
    expect(dayStart("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(dayStart("2026-10-26").getTime() - dayStart("2026-10-25").getTime()).toBe(25 * 3_600_000);
  });

  it("keeps 10:00 when adding days across the change", () => {
    const spring = new Date("2026-03-28T09:00:00Z"); // 10:00 CET
    expect(clock(addLocalDays(spring, 1))).toBe("10:00");
    expect(addLocalDays(spring, 1).toISOString()).toBe("2026-03-29T08:00:00.000Z");
    const autumn = new Date("2026-10-19T08:00:00Z"); // Monday 10:00 CEST
    expect(addLocalDays(autumn, 7).toISOString()).toBe("2026-10-26T09:00:00.000Z"); // Monday 10:00 CET
    expect(addLocalDays(addLocalDays(autumn, 7), -7).toISOString()).toBe(autumn.toISOString());
  });

  it("reads day keys and clock times in local time", () => {
    expect(dayKey(at("2026-03-28T22:59:00Z"))).toBe("2026-03-28");
    expect(dayKey(at("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
    expect(clock(at("2026-03-29T01:00:00Z"))).toBe("03:00"); // 02:00 never happens
    expect(clock(at("2026-10-25T00:30:00Z"))).toBe("02:30"); // CEST
    expect(clock(at("2026-10-25T01:30:00Z"))).toBe("02:30"); // CET, the second time round
  });

  it("parses datetime-local values: a skipped time moves forward, a repeated one is the first", () => {
    expect(fromLocalInput("2026-03-29T02:30")?.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // = 03:30 CEST
    expect(fromLocalInput("2026-10-25T02:30")?.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // the CEST one
    expect(fromLocalInput("2026-07-01T10:00")?.toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(toLocalInput(at("2026-07-01T08:00:00Z"))).toBe("2026-07-01T10:00");
    expect(fromLocalInput("2026-02-31T10:00")).toBeNull();
    expect(fromLocalInput("2026-02-28 10:00")).toBeNull();
  });

  it("gives the local weekday", () => {
    expect(zonedParts(at("2026-10-25T22:59:00Z")).weekday).toBe(0); // Sunday 23:59 CET
    expect(zonedParts(at("2026-10-25T23:00:00Z")).weekday).toBe(1);
  });
});

describe("half-hour and 45-minute zones", () => {
  afterEach(() => resetTimeZoneForTests());

  it("Asia/Kolkata (UTC+5:30) around midnight", () => {
    resetTimeZoneForTests("Asia/Kolkata");
    expect(clock(at("2026-10-12T18:29:00Z"))).toBe("23:59");
    expect(dayKey(at("2026-10-12T18:29:00Z"))).toBe("2026-10-12");
    expect(clock(at("2026-10-12T18:30:00Z"))).toBe("00:00");
    expect(dayKey(at("2026-10-12T18:30:00Z"))).toBe("2026-10-13");
    expect(dayStart("2026-10-13").toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(clockSeconds(at("2026-10-12T18:30:07Z"))).toBe("00:00:07");
  });

  it("Asia/Kathmandu (UTC+5:45) around midnight", () => {
    resetTimeZoneForTests("Asia/Kathmandu");
    expect(clock(at("2026-10-12T18:14:00Z"))).toBe("23:59");
    expect(dayKey(at("2026-10-12T18:14:00Z"))).toBe("2026-10-12");
    expect(clock(at("2026-10-12T18:15:00Z"))).toBe("00:00");
    expect(dayKey(at("2026-10-12T18:15:00Z"))).toBe("2026-10-13");
    expect(dayStart("2026-10-13").toISOString()).toBe("2026-10-12T18:15:00.000Z");
    expect(toLocalInput(at("2026-10-12T18:15:00Z"))).toBe("2026-10-13T00:00");
    expect(fromLocalInput("2026-10-13T00:00")?.toISOString()).toBe("2026-10-12T18:15:00.000Z");
  });
});

describe("the default zone keeps the WIB maths", () => {
  it("day keys, midnight and datetime-local values in Asia/Jakarta", () => {
    resetTimeZoneForTests();
    expect(dayKey(at("2026-10-12T17:30:00Z"))).toBe("2026-10-13");
    expect(dayStart("2026-10-13").toISOString()).toBe("2026-10-12T17:00:00.000Z");
    expect(toLocalInput(at("2026-10-13T15:00:00Z"))).toBe("2026-10-13T22:00");
    expect(fromLocalInput("2026-10-13T22:00")?.toISOString()).toBe("2026-10-13T15:00:00.000Z");
    expect(addLocalDays(at("2026-10-13T15:00:00Z"), 7).toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(clockSeconds(at("2026-10-13T15:00:09Z"))).toBe("22:00:09");
    expect(calendarDate(at("2026-09-30T20:00:00Z"))).toEqual({ day: 1, month: "Oct", year: 2026 });
  });
});

describe("review fixes (1.1, fix round 1)", () => {
  afterEach(() => {
    resetTimeZoneForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses offsets such as +07:00, -05:00 and +0530 (Postgres would read them otherwise), with the warning", () => {
    for (const bad of ["+07:00", "-05:00", "+0530", "UTC+7", "IST", "CET", "cet", "BST", "AET", "ECT", "EST", "PST", "EST5EDT", "GB", "Zulu", "Etc/", "/Berlin"]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      resetTimeZoneForTests(bad);
      expect(timeZone(), bad).toBe("Asia/Jakarta");
      expect(warn, bad).toHaveBeenCalledTimes(1);
      expect(zoneProblem()).toBe(`WATCHBELL_TIMEZONE=${bad}`);
      warn.mockRestore();
    }
    resetTimeZoneForTests("Etc/GMT-7"); // IANA-shaped: UTC+7 in Intl and in Postgres alike
    expect(timeZone()).toBe("Etc/GMT-7");
    expect(zoneProblem()).toBeNull();
    expect(clock(at("2026-10-12T20:30:00Z"))).toBe("03:30");
    for (const ok of ["UTC", "utc", "GMT", "Etc/UTC", "Etc/GMT-7", "Etc/GMT+5", "US/Pacific", "America/Argentina/Buenos_Aires", "Europe/London", "Asia/Kolkata"]) {
      resetTimeZoneForTests(ok);
      expect(zoneProblem(), ok).toBeNull();
      expect(timeZone().toLowerCase(), ok).toBe(ok.toLowerCase());
    }
  });

  it("writes a name that differs only in case the current way, legacy names included", () => {
    resetTimeZoneForTests("asia/kolkata");
    expect(timeZone()).toBe("Asia/Kolkata");
    resetTimeZoneForTests("asia/calcutta");
    expect(timeZone()).toBe("Asia/Calcutta"); // the operator wrote the old name: kept
    resetTimeZoneForTests("ASIA/KATHMANDU");
    expect(timeZone()).toBe("Asia/Kathmandu");
  });

  it("builds a formatter once per zone, locale and options", () => {
    resetTimeZoneForTests("Europe/Berlin");
    const a = zonedFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    expect(zonedFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })).toBe(a);
    expect(a.format(at("2026-07-01T08:00:00Z"))).toBe("10:00");
    resetTimeZoneForTests("Asia/Kolkata");
    expect(zonedFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })).not.toBe(a);
    expect(zoneLabel(at("2026-01-15T12:00:00Z"))).toBe("GMT+5:30");
  });

  it("the daily job's time: 03:00 on the local clock in self-host, Vercel Cron's 20:00 UTC in cloud", () => {
    const winter = at("2026-01-15T12:00:00Z");
    const summer = at("2026-07-15T12:00:00Z");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    resetTimeZoneForTests();
    expect(dailyRunText(winter)).toBe("03:00 WIB");
    resetTimeZoneForTests("Europe/Berlin");
    expect(dailyRunText(winter)).toBe("03:00 Europe/Berlin");
    vi.stubEnv("WATCHBELL_MODE", "");
    expect(dailyRunText(winter)).toBe("21:00 CET");
    expect(dailyRunText(summer)).toBe("22:00 CEST");
    expect(vercelCronText(summer)).toBe("22:00 CEST");
    resetTimeZoneForTests();
    expect(dailyRunText(winter)).toBe("03:00 WIB"); // prod (cloud, no zone): as before
    expect(vercelCronText(winter)).toBe("03:00 WIB");
  });
});

// The CLI and the installers can't import this module, so they keep copies of LEGACY_ZONES (fix round 2, N2). The
// installers sit in public-edition/ here and at the root of the public export.
describe("the copies of LEGACY_ZONES", () => {
  const read = (...candidates: string[]) => {
    const found = candidates.map((c) => new URL(c, import.meta.url)).find((u) => existsSync(u));
    return found ? readFileSync(found, "utf8") : null;
  };
  const pairs = (text: string) => {
    const line = text.split(/\r?\n/).find((l) => /["']Asia\/Calcutta["']\s*:/.test(l)) ?? ""; // the map, not a comment naming it
    return Object.fromEntries([...line.matchAll(/["'](\w+\/\w+)["']\s*:\s*["'](\w+\/\w+)["']/g)].map((m) => [m[1], m[2]]));
  };
  it("match in the CLI and both installers", () => {
    const files = {
      cli: read("../../bin/watchbell.mjs"),
      sh: read("../../../public-edition/install.sh", "../../../install.sh"),
      ps1: read("../../../public-edition/install.ps1", "../../../install.ps1"),
    };
    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toBeNull();
      expect(pairs(text!), name).toEqual(LEGACY_ZONES);
    }
  });
});
