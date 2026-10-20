import { afterEach, describe, expect, it } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import { opById } from "./operations";

// Review A, finding 2: the daily op's description is read when it is rendered, not when the module loads, so the API
// explorer in the browser (which loads this module before TimeZoneSync runs) renders what the server rendered.
describe("the daily job's description follows the zone when read", () => {
  afterEach(() => resetTimeZoneForTests());

  it("is 03:00 WIB by default, as before", () => {
    resetTimeZoneForTests();
    expect(opById("daily")?.description).toBe("Vercel Cron at 03:00 WIB with Authorization: Bearer <CRON_SECRET>. Docs only.");
  });

  it("changes with the zone after the module is loaded", () => {
    resetTimeZoneForTests("Europe/Berlin");
    expect(opById("daily")?.description).toMatch(/^Vercel Cron at 2[12]:00 CES?T with Authorization/);
    resetTimeZoneForTests("Asia/Kolkata");
    expect(opById("daily")?.description).toMatch(/^Vercel Cron at 01:30 GMT\+5:30 with/);
  });
});
