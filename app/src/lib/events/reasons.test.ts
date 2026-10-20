import { describe, expect, it } from "vitest";
import { eventSource, reasonFor, repeatable, repeatText } from "./reasons";

const now = new Date("2026-10-13T12:00:00Z");

describe("reasonFor", () => {
  it("keeps an explicit reason", () => {
    expect(reasonFor({ type: "database", message: "Supabase project paused", reason: "DatabasePaused" })).toBe("DatabasePaused");
  });
  it.each([
    ["monitor", "Monitor down", "MonitorDown"], ["monitor", "Monitor degraded", "MonitorDegraded"], ["monitor", "Monitor recovered", "MonitorRecovered"],
    ["deployment", "Deployment started", "DeployStarted"], ["deployment", "Deployment ready", "DeployReady"],
    ["deployment", "Deployment failed", "DeployFailed"], ["deployment", "Deployment canceled", "DeployCanceled"],
    ["system", "Collector stopped", "CollectorStopped"], ["system", "Daily jobs finished", "DailyFinished"],
    ["system", "Daily jobs finished with problems", "DailyProblems"], ["action", "Check now: a.com/", "Action"],
  ])("%s · %s → %s", (type, message, reason) => expect(reasonFor({ type, message })).toBe(reason));
  it("returns null for a message it doesn't know", () => {
    expect(reasonFor({ type: "system", message: "Something new" })).toBeNull();
  });
});

describe("repeatable", () => {
  it("bumps known reasons but never actions or unknowns", () => {
    expect(repeatable("MonitorDown")).toBe(true);
    expect(repeatable("Action")).toBe(false);
    expect(repeatable(null)).toBe(false);
  });
});

describe("repeatText", () => {
  it("says nothing for a single occurrence", () => {
    expect(repeatText(1, null, now)).toBeNull();
  });
  it("counts and dates repeats", () => {
    expect(repeatText(4, new Date(now.getTime() - 120_000), now)).toBe("×4 · last 2 min ago");
    expect(repeatText(2, new Date(now.getTime() - 5_000), now)).toBe("×2 · last 5s ago");
  });
});

describe("eventSource", () => {
  it("names the provider on a provider-status event, which has no resource", () => {
    expect(eventSource({ type: "system", reason: "ProviderIncident", message: "Cloudflare reports an incident", resource: null })).toBe("Cloudflare");
    expect(eventSource({ type: "system", reason: "ProviderRecovered", message: "Google Cloud incident resolved", resource: null })).toBe("Google Cloud");
  });
  it("prefers a real resource name", () => {
    expect(eventSource({ type: "database", reason: "DatabasePaused", message: "x", resource: "ticketer" })).toBe("ticketer");
  });
  it("falls back to collector for other system events and console for the rest", () => {
    expect(eventSource({ type: "system", reason: "DailyFinished", message: "Daily jobs finished", resource: null })).toBe("collector");
    expect(eventSource({ type: "action", reason: "Action", message: "Check now", resource: null })).toBe("console");
  });
  it("keeps the old fallback when a provider message has an unexpected shape", () => {
    expect(eventSource({ type: "system", reason: "ProviderIncident", message: "Something else", resource: null })).toBe("collector");
  });
});
