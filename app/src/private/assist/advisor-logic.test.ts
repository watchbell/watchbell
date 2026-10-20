import { describe, expect, it, vi } from "vitest";
import type { ConsoleSnapshot } from "@/private/console/types";
import { advisorPrompt, advisorWindow, parseAdvisorNotes, parseAdvisorSettings, pickAdvisorApps } from "./advisor-logic";

// The always-covered app is configuration (advisor-config.ts); the tests use their own.
vi.mock("./advisor-config", () => ({ ALWAYS_APP: "main-site" }));
const MAIN = "main-site";

const wib = (hhmm: string, day = "2026-10-14") => new Date(`${day}T${hhmm}:00+07:00`);

describe("advisorWindow: [07:00, 07:15) and [19:00, 19:15) WIB", () => {
  it.each([
    ["07:00", "2026-10-14T07"], ["07:14", "2026-10-14T07"], ["19:00", "2026-10-14T19"], ["19:14", "2026-10-14T19"],
  ])("%s WIB → %s", (t, w) => { expect(advisorWindow(wib(t))).toBe(w); });
  it.each([["06:59"], ["07:15"], ["12:00"], ["18:59"], ["19:15"], ["00:00"]])("%s WIB → null", (t) => { expect(advisorWindow(wib(t))).toBeNull(); });
  it("uses the WIB date (07:05 WIB is still the previous UTC day)", () => {
    expect(advisorWindow(new Date("2026-10-14T00:05:00.000Z"))).toBe("2026-10-14T07");
  });
});

describe("parseAdvisorSettings", () => {
  it("defaults on with the default model; keeps a model id; off only when false", () => {
    expect(parseAdvisorSettings(undefined)).toEqual({ enabled: true, model: null });
    expect(parseAdvisorSettings({ enabled: false, model: "test/prrojects" })).toEqual({ enabled: false, model: "test/prrojects" });
    expect(parseAdvisorSettings({ enabled: "no", model: 3 })).toEqual({ enabled: true, model: null });
  });
});

const app = (id: string, state: ConsoleSnapshot["apps"][number]["state"] = "running") => ({ id, state, uptime30d: 99.9, database: null, lastDeploy: null, problems: [] });
const snap = (o: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot => ({
  generatedAt: "2026-10-14T00:05:00.000Z",
  apps: [app(MAIN), app("web-a", "down"), app("web-b"), app("web-c", "degraded"), app("web-d"), app("web-e")],
  monitors: { up: 5, degraded: 0, down: 1, paused: 0, items: [{ app: "web-d", state: "down", path: "/health" }] },
  alerts: { open: 1, critical: 1, items: [{ app: "web-b", severity: "critical", title: "5xx", message: "HTTP 502", since: "x" }] },
  advisor: [{ title: "Upgrade Next", app: "web-e", severity: "warn" }],
  ...o,
});

describe("pickAdvisorApps", () => {
  it("the main app always, then at most 3 others by urgency (down, alert, failing monitor/degraded, recommendation)", () => {
    expect(pickAdvisorApps(snap())).toEqual([MAIN, "web-a", "web-b", "web-c"]);
  });
  it("healthy console: only the main app; and it is left out when it isn't watched", () => {
    expect(pickAdvisorApps(snap({ apps: [app(MAIN), app("web-z")], alerts: { open: 0, critical: 0 }, monitors: { up: 2, degraded: 0, down: 0, paused: 0 }, advisor: [] }))).toEqual([MAIN]);
    expect(pickAdvisorApps(snap({ apps: [app("web-a", "down")] }))).toEqual(["web-a"]);
  });
});

describe("advisorPrompt", () => {
  it("asks for JSON notes for exactly the picked apps, from scrubbed data only", () => {
    const s = snap({ apps: [{ ...app("web-a", "down"), problems: [{ kind: "monitor", where: "https://secret.example.com/x", what: "owner@example.com saw 502", fix: null }] }] });
    const [sys, user] = advisorPrompt(s, ["web-a"]);
    expect(sys.role).toBe("system");
    expect(user.content).toContain('{"notes":[');
    expect(user.content).toContain("web-a");
    expect(user.content).not.toContain("web-b");
    expect(user.content).not.toContain("secret.example.com");
    expect(user.content).not.toContain("owner@example.com");
  });
});

describe("parseAdvisorNotes (Zod; invalid items dropped)", () => {
  const apps = [MAIN, "web-a"];
  const note = (o: object = {}) => ({ app: "web-a", severity: "crit", title: "web-a is down after a deploy", body: "The last deploy fails with 502. Roll back to the previous build first.", ...o });
  const text = (notes: unknown[]) => JSON.stringify({ notes });
  it("keeps valid notes, matched to the app's name; tolerates a code fence", () => {
    expect(parseAdvisorNotes("```json\n" + text([note(), note({ app: MAIN.toUpperCase(), severity: "info", title: "All good" })]) + "\n```", apps)).toEqual([
      { app: "web-a", severity: "crit", title: "web-a is down after a deploy", body: note().body },
      { app: MAIN, severity: "info", title: "All good", body: note().body },
    ]);
  });
  it.each([
    ["an unknown app", note({ app: "web-x" })],
    ["a bad severity", note({ severity: "high" })],
    ["a title of 80 characters", note({ title: "x".repeat(80) })],
    ["more than 4 sentences", note({ body: "One. Two. Three. Four. Five." })],
    ["a URL", note({ body: "Check https://web-a.example.com/health now please." })],
    ["a host", note({ body: "Check web-a.vercel.app before the weekend please." })],
    ["an email", note({ body: "Mail owner@example.com about the failing build." })],
    ["a key", note({ body: "Rotate the key sk-abcdef123456 used by the build." })],
  ])("drops %s", (_n, bad) => {
    expect(parseAdvisorNotes(text([bad]), apps)).toEqual([]);
  });
  it("one note per app, at most 4, and nothing from text that isn't JSON", () => {
    const many = ["a", "b", "c", "d", "e"].map((x) => note({ app: x }));
    expect(parseAdvisorNotes(text(many), ["a", "b", "c", "d", "e"])).toHaveLength(4);
    expect(parseAdvisorNotes(text([note(), note({ title: "again" })]), apps)).toHaveLength(1);
    expect(parseAdvisorNotes("I can't do that.", apps)).toEqual([]);
    expect(parseAdvisorNotes("{ broken", apps)).toEqual([]);
  });
});
