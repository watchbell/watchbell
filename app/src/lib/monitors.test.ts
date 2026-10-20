import { describe, expect, it } from "vitest";
import {
  bodyFailure, checkNowMessage, deleteBlock, heartbeatLimitBlock, isChecked, lastResultMessage, limitBlock, overLimitText, parseHeartbeatForm, parseMonitorForm, resetsState, resumeIds,
} from "./monitors";

describe("isChecked", () => {
  it("checks a monitor only when neither Sync nor the owner paused it", () => {
    expect(isChecked({ paused: false, ownerPaused: false })).toBe(true);
    expect(isChecked({ paused: true, ownerPaused: false })).toBe(false);
    expect(isChecked({ paused: false, ownerPaused: true })).toBe(false);
  });
});

describe("resumeIds", () => {
  it("resumes monitors Sync paused, never the ones the owner paused", () => {
    expect(resumeIds([
      { id: "a", paused: true, ownerPaused: false },
      { id: "b", paused: true, ownerPaused: true },
      { id: "c", paused: false, ownerPaused: false },
      { id: "d", paused: false, ownerPaused: true },
    ])).toEqual(["a"]);
  });
});

describe("parseMonitorForm", () => {
  const ok = { url: "https://example.com/api/health", expectedStatus: "200", timeoutS: "5" };
  it("accepts a full https address, a status and a timeout", () => {
    expect(parseMonitorForm(ok)).toEqual({ ok: true, value: { url: "https://example.com/api/health", expectedStatus: 200, timeoutMs: 5000, bodyContains: null, jsonPath: null, jsonEquals: null } });
  });
  it("normalises the address: trailing slash on a bare host, no fragment", () => {
    expect(parseMonitorForm({ ...ok, url: " https://example.com " })).toMatchObject({ value: { url: "https://example.com/" } });
    expect(parseMonitorForm({ ...ok, url: "https://example.com/#top" })).toMatchObject({ value: { url: "https://example.com/" } });
  });
  it("accepts any expected status from 100 to 599, so an API-only app can expect 404 at / (carry-over c)", () => {
    expect(parseMonitorForm({ ...ok, expectedStatus: "404" })).toMatchObject({ ok: true, value: { expectedStatus: 404 } });
    expect(parseMonitorForm({ ...ok, expectedStatus: "401" })).toMatchObject({ ok: true, value: { expectedStatus: 401 } });
  });
  it("rejects anything but a plain https address, with the mockup's message", () => {
    for (const url of ["http://example.com/", "example.com", "https://user:pw@example.com/", "", "https://"]) {
      expect(parseMonitorForm({ ...ok, url })).toEqual({ ok: false, fieldErrors: { url: "Enter a full https:// address." } });
    }
  });
  it("refuses private and internal addresses and other ports, with a clear message (I1)", () => {
    for (const url of [
      "https://127.0.0.1/", "https://localhost/", "https://app.localhost/", "https://printer.local/", "https://db.internal/", "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/", "https://172.16.0.1/", "https://192.168.1.1/", "https://100.64.0.1/", "https://0.0.0.0/", "https://[::1]/", "https://[fc00::1]/", "https://[fe80::1]/",
      "https://[::ffff:127.0.0.1]/", "https://0x7f.1/", "https://2130706433/", "https://example.com:8443/", "https://example.com:80/", "https://intranet/",
    ]) {
      expect(parseMonitorForm({ ...ok, url })).toEqual({ ok: false, fieldErrors: { url: "Use a public https address." } });
    }
  });
  it("accepts an explicit 443 and a public IP literal", () => {
    expect(parseMonitorForm({ ...ok, url: "https://example.com:443/health" })).toMatchObject({ ok: true, value: { url: "https://example.com/health" } });
    expect(parseMonitorForm({ ...ok, url: "https://8.8.8.8/" })).toMatchObject({ ok: true });
  });
  it("rejects a status outside 100–599, with the mockup's message", () => {
    for (const expectedStatus of ["99", "600", "abc", "", "2000"]) {
      expect(parseMonitorForm({ ...ok, expectedStatus })).toEqual({ ok: false, fieldErrors: { expectedStatus: "Enter an HTTP status between 100 and 599." } });
    }
  });
  it("only offers the mockup's timeouts", () => {
    expect(parseMonitorForm({ ...ok, timeoutS: "7" })).toEqual({ ok: false, fieldErrors: { timeoutS: "Pick a timeout." } });
    expect(parseMonitorForm({ ...ok, timeoutS: "10" })).toMatchObject({ value: { timeoutMs: 10_000 } });
  });
  it("keeps a keyword up to 200 characters", () => {
    expect(parseMonitorForm({ ...ok, bodyContains: "  \"status\":\"ok\" " })).toMatchObject({ ok: true, value: { bodyContains: '"status":"ok"', jsonPath: null, jsonEquals: null } });
    expect(parseMonitorForm({ ...ok, bodyContains: "   " })).toMatchObject({ ok: true, value: { bodyContains: null } });
    expect(parseMonitorForm({ ...ok, bodyContains: "x".repeat(200) })).toMatchObject({ ok: true });
    expect(parseMonitorForm({ ...ok, bodyContains: "x".repeat(201) })).toMatchObject({ ok: false, fieldErrors: { bodyContains: expect.any(String) } });
  });
  it("accepts a JSON path with the value it must equal", () => {
    expect(parseMonitorForm({ ...ok, jsonPath: " checks.db ", jsonEquals: "ok" })).toMatchObject({ ok: true, value: { bodyContains: null, jsonPath: "checks.db", jsonEquals: "ok" } });
    expect(parseMonitorForm({ ...ok, jsonPath: "items[0].state", jsonEquals: "up" })).toMatchObject({ ok: true });
  });
  it("rejects a JSON path that isn't dots and [0], and one without a value", () => {
    for (const jsonPath of ["a..b", "a[x]", "$..x", "a.b()", "constructor.prototype", "x".repeat(101)]) {
      expect(parseMonitorForm({ ...ok, jsonPath, jsonEquals: "ok" })).toEqual({ ok: false, fieldErrors: { jsonPath: "Use dots and [0] only, like checks.db or items[0].state." } });
    }
    expect(parseMonitorForm({ ...ok, jsonPath: "status" })).toEqual({ ok: false, fieldErrors: { jsonEquals: "Enter the value it must equal." } });
    expect(parseMonitorForm({ ...ok, jsonPath: "status", jsonEquals: "x".repeat(201) })).toMatchObject({ ok: false, fieldErrors: { jsonEquals: expect.any(String) } });
  });
  it("rejects a value without a path instead of dropping it", () => {
    expect(parseMonitorForm({ ...ok, jsonEquals: "ok" })).toEqual({ ok: false, fieldErrors: { jsonPath: "Add a JSON path for the value." } });
    expect(parseMonitorForm({ ...ok, jsonEquals: "   " })).toMatchObject({ ok: true, value: { jsonPath: null, jsonEquals: null } });
  });
  it("takes a keyword or a JSON field, not both", () => {
    expect(parseMonitorForm({ ...ok, bodyContains: "ok", jsonPath: "status", jsonEquals: "ok" })).toEqual({ ok: false, fieldErrors: { bodyContains: "Use either a keyword or a JSON field." } });
  });
  it("survives junk from a crafted request", () => {
    const r = parseMonitorForm(null);
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.fieldErrors).sort()).toEqual(["expectedStatus", "timeoutS", "url"]);
  });
});

describe("limitBlock", () => {
  it("allows up to 20 active monitors", () => {
    expect(limitBlock(19)).toBeNull();
    expect(limitBlock(20)).toBe("The console checks at most 20 monitors. Pause or delete one first.");
    expect(limitBlock(18, 3)).not.toBeNull();
    expect(limitBlock(20, 0)).toBeNull();
  });
});

describe("deleteBlock", () => {
  it("keeps the last monitor of a watched app, since Sync would add it back", () => {
    expect(deleteBlock({ appWatched: true, monitorsOfApp: 1 })).toBe("This is the app's only monitor, and Sync would add it back. Pause it instead.");
    expect(deleteBlock({ appWatched: true, monitorsOfApp: 2 })).toBeNull();
    expect(deleteBlock({ appWatched: false, monitorsOfApp: 1 })).toBeNull();
  });
});

describe("resetsState", () => {
  const v = { url: "https://example.com/", expectedStatus: 200, timeoutMs: 5000, bodyContains: null, jsonPath: null, jsonEquals: null };
  it("starts the state afresh when what is checked changes, not for a new timeout", () => {
    expect(resetsState(v, { ...v, url: "https://example.com/api/health" })).toBe(true);
    expect(resetsState(v, { ...v, expectedStatus: 404 })).toBe(true);
    expect(resetsState(v, { ...v, timeoutMs: 10_000 })).toBe(false);
  });
});

describe("checkNowMessage", () => {
  it("reports the answer", () => {
    expect(checkNowMessage({ ok: true, statusCode: 200, latencyMs: 182, error: null })).toBe("Answered 200 in 182 ms.");
    expect(checkNowMessage({ ok: false, statusCode: 502, latencyMs: 90, error: "HTTP 502" })).toBe("Failed: HTTP 502.");
    expect(checkNowMessage({ ok: false, statusCode: null, latencyMs: null, error: null })).toBe("Failed: no answer.");
  });
});

describe("overLimitText (final review I3)", () => {
  it("says nothing when every app fits", () => {
    expect(overLimitText(0)).toBeNull();
  });
  it("names how many apps are over the 20-monitor limit, in the cap's own words", () => {
    expect(overLimitText(1)).toBe("1 app is over the 20-monitor limit, so its monitor stays paused. Pause or delete one, then resume it on Uptime.");
    expect(overLimitText(3)).toBe("3 apps are over the 20-monitor limit, so their monitors stay paused. Pause or delete one, then resume them on Uptime.");
  });
});

describe("bodyFailure", () => {
  it("is the saved error only when the monitor was answered but failed its body rule", () => {
    expect(bodyFailure({ lastStatus: 200, lastError: "Keyword not found" })).toBe("Keyword not found");
    expect(bodyFailure({ lastStatus: 200, lastError: "Body not read within 5 s" })).toBe("Body not read within 5 s");
    expect(bodyFailure({ lastStatus: 502, lastError: "HTTP 502" })).toBeNull();
    expect(bodyFailure({ lastStatus: null, lastError: "No answer within 5 s" })).toBeNull();
    expect(bodyFailure({ lastStatus: 200, lastError: null })).toBeNull();
    expect(bodyFailure({ lastStatus: 200 })).toBeNull();
  });
});

describe("lastResultMessage", () => {
  it("shows the last error when there is one", () => {
    const now = new Date("2026-10-12T10:00:30Z"), at = new Date("2026-10-12T10:00:18Z");
    expect(lastResultMessage({ lastCheckedAt: at, lastStatus: 200, lastLatencyMs: 90, expectedStatus: 200, lastError: "Keyword not found" }, now)).toBe("Checked 12s ago: failed (Keyword not found).");
  });
  const now = new Date("2026-10-12T10:00:00Z");
  const at = new Date(now.getTime() - 12_000);
  it("reports the last answer of a monitor checked moments ago", () => {
    expect(lastResultMessage({ lastCheckedAt: at, lastStatus: 200, lastLatencyMs: 380, expectedStatus: 200 }, now)).toBe("Checked 12s ago: 200 in 380 ms.");
  });
  it("reports a wrong status as a failure with its code", () => {
    expect(lastResultMessage({ lastCheckedAt: at, lastStatus: 502, lastLatencyMs: 90, expectedStatus: 200 }, now)).toBe("Checked 12s ago: failed (HTTP 502).");
  });
  it("reports no answer when there was no status", () => {
    expect(lastResultMessage({ lastCheckedAt: at, lastStatus: null, lastLatencyMs: null, expectedStatus: 200 }, now)).toBe("Checked 12s ago: failed (no answer).");
  });
  it("counts an expected non-200 status as a pass", () => {
    expect(lastResultMessage({ lastCheckedAt: at, lastStatus: 404, lastLatencyMs: 50, expectedStatus: 404 }, now)).toBe("Checked 12s ago: 404 in 50 ms.");
  });
});

describe("parseHeartbeatForm (U3)", () => {
  it("takes a trimmed name and one of the offered periods and graces", () => {
    expect(parseHeartbeatForm({ name: "  backup job ", periodS: "86400", graceS: "3600" })).toEqual({ ok: true, value: { name: "backup job", periodS: 86_400, graceS: 3600 } });
    expect(parseHeartbeatForm({ name: "db dump", periodS: 300, graceS: 21_600 })).toEqual({ ok: true, value: { name: "db dump", periodS: 300, graceS: 21_600 } });
  });
  it("asks for a name with a letter or digit in it, up to 60 characters", () => {
    for (const name of ["", "   ", "!!!", "a\u0000b"]) expect(parseHeartbeatForm({ name, periodS: "3600", graceS: "300" })).toEqual({ ok: false, fieldErrors: { name: "Name the job, like backup job." } });
    expect(parseHeartbeatForm({ name: "x".repeat(61), periodS: "3600", graceS: "300" })).toEqual({ ok: false, fieldErrors: { name: "Keep the name to 60 characters." } });
    // 5b final review M9: bidi overrides and isolates, zero-width and other invisible characters could disguise a job
    // in a Telegram or email alert.
    for (const name of ["backup‮job", "backup⁦job⁩", "back​up", "back‍up", "back‏up", "back⁠up", "back­up", "back\u0085up", "back؜up", "back﻿up"]) {
      expect(parseHeartbeatForm({ name, periodS: "3600", graceS: "300" }), JSON.stringify(name)).toEqual({ ok: false, fieldErrors: { name: "Name the job, like backup job." } });
    }
    expect(parseHeartbeatForm({ name: "sauvegarde nocturne · café", periodS: "3600", graceS: "300" }).ok).toBe(true);
    expect(parseHeartbeatForm({ name: "x".repeat(60), periodS: "3600", graceS: "300" }).ok).toBe(true);
  });
  it("accepts only the offered periods and graces, whatever a crafted request sends", () => {
    expect(parseHeartbeatForm({ name: "job", periodS: "60", graceS: "1" })).toEqual({ ok: false, fieldErrors: { periodS: "Pick how often the job runs.", graceS: "Pick a grace time." } });
    expect(parseHeartbeatForm(null)).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), periodS: expect.any(String), graceS: expect.any(String) } });
  });
});

describe("heartbeatLimitBlock", () => {
  it("allows 20 heartbeats, paused ones included", () => {
    expect(heartbeatLimitBlock(19)).toBeNull();
    expect(heartbeatLimitBlock(20)).toBe("The console keeps at most 20 heartbeats. Delete one first.");
  });
});
