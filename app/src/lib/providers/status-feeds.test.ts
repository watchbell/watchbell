import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseGoogle, parseStatusIo, parseStatuspage, readFeed, safeLink } from "./status-feeds";

// MSW lets unmatched requests for .json through to the real network; every feed here ends in .json. This catch-all,
// kept by resetHandlers, turns any unmatched request into a network error and records it (same as osv.test.ts).
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const now = new Date("2026-10-13T12:00:00Z");

describe("safeLink", () => {
  it("keeps https links on status hosts and drops everything else", () => {
    expect(safeLink("https://stspg.io/x")).toBe("https://stspg.io/x");
    expect(safeLink("https://status.supabase.com/incidents/1")).toBe("https://status.supabase.com/incidents/1");
    for (const bad of ["javascript:alert(1)", "http://stspg.io/x", "https://evil.example/stspg.io", "https://stspg.io.evil.example/x", "https://u:p@stspg.io/x", "not a url", null, 5]) expect(safeLink(bad)).toBeNull();
  });
  it("is applied to the links in a feed", () => {
    const r = parseStatuspage({ status: { indicator: "minor", description: "x" }, incidents: [{ name: "n", impact: "minor", started_at: "2026-10-13T11:00:00Z", shortlink: "javascript:alert(1)" }] });
    expect(r?.incidents[0].url).toBeNull();
  });
});

describe("parseStatuspage", () => {
  it("maps the indicator and lists unresolved incidents", () => {
    const r = parseStatuspage({
      status: { indicator: "minor", description: "Minor Service Outage" },
      incidents: [{ name: "Builds delayed", impact: "minor", started_at: "2026-10-13T11:00:00Z", shortlink: "https://stspg.io/x", status: "investigating" }],
    });
    expect(r).toEqual({ state: "warn", indicator: "minor", description: "Minor Service Outage",
      incidents: [{ name: "Builds delayed", impact: "minor", startedAt: "2026-10-13T11:00:00Z", url: "https://stspg.io/x" }] });
  });
  it("counts only in-progress maintenance, and for Cloudflare only the configured colos", () => {
    const maintenances = [
      { name: "SYD (Sydney) on 2026-10-12", status: "in_progress", impact: "maintenance", scheduled_for: "2026-10-12T15:00:00Z" },
      { name: "SIN (Singapore) on 2026-10-13", status: "in_progress", impact: "maintenance", scheduled_for: "2026-10-13T19:00:00Z" },
      { name: "Scheduled Platform Maintenance 07/02", status: "scheduled", impact: "maintenance" },
    ];
    const r = parseStatuspage({ status: { indicator: "none", description: "All Systems Operational" }, maintenances }, { colos: ["SIN", "CGK"] });
    expect(r).toMatchObject({ state: "info", indicator: "maintenance", description: "Scheduled maintenance · SIN (Singapore) on 2026-10-13" });
    expect(parseStatuspage({ status: { indicator: "none", description: "All Systems Operational" }, maintenances: maintenances.slice(0, 1) }, { colos: ["SIN"] }))
      .toMatchObject({ state: "ok", description: "All Systems Operational" });
  });
  it("tolerates Supabase's summary without an incidents key and rejects garbage", () => {
    expect(parseStatuspage({ status: { indicator: "none", description: "All Systems Operational" } })).toMatchObject({ state: "ok", incidents: [] });
    expect(parseStatuspage({ status: "<html>" })).toBeNull();
  });
  it("maps major and critical to err", () => {
    expect(parseStatuspage({ status: { indicator: "critical", description: "Major outage" } })?.state).toBe("err");
  });
  it("colours an open incident by its own impact, not the page's overall indicator (owner 19 Oct: minor is yellow)", () => {
    const inc = (impact: string) => ({ name: "Incorrect geo location for some WARP users", impact, started_at: "2026-08-27T18:46:00Z", shortlink: "https://stspg.io/w" });
    const minor = parseStatuspage({ status: { indicator: "major", description: "Partial System Outage" }, incidents: [inc("minor")] });
    expect(minor).toMatchObject({ state: "warn", indicator: "minor", description: "Minor incident" });
    expect(parseStatuspage({ status: { indicator: "minor", description: "x" }, incidents: [inc("minor"), inc("critical")] })).toMatchObject({ state: "err", indicator: "critical", description: "Critical incident" });
    expect(parseStatuspage({ status: { indicator: "major", description: "Partial System Outage" }, incidents: [inc("major")] })).toMatchObject({ state: "err", description: "Partial System Outage" });
    expect(parseStatuspage({ status: { indicator: "none", description: "All Systems Operational" }, incidents: [inc("none")] })).toMatchObject({ state: "warn", indicator: "none", description: "Open incident" });
  });
  it("for Cloudflare without an incident, judges data centres only by the configured colos", () => {
    const comp = (name: string, status: string) => ({ name, status });
    const far = [comp("La Paz, Bolivia - (LPB)", "major_outage"), comp("Chengdu, China - (CTU)", "degraded_performance"), comp("Singapore, Singapore - (SIN)", "operational")];
    const status = { indicator: "major", description: "Partial System Outage" };
    expect(parseStatuspage({ status, components: far }, { colos: ["SIN", "CGK"] })).toMatchObject({ state: "ok", indicator: "none", description: "No open incidents near SIN, CGK" });
    expect(parseStatuspage({ status, components: [...far, comp("Jakarta, Indonesia - (CGK)", "degraded_performance")] }, { colos: ["SIN", "CGK"] }))
      .toMatchObject({ state: "warn", indicator: "minor", description: "CGK data centre: degraded performance" });
    expect(parseStatuspage({ status, components: [comp("Singapore, Singapore - (SIN)", "major_outage")] }, { colos: ["SIN"] })).toMatchObject({ state: "err", indicator: "major", description: "SIN data centre: major outage" });
    const maintenances = [{ name: "SIN (Singapore) on 2026-10-13", status: "in_progress", impact: "maintenance", scheduled_for: "2026-10-13T19:00:00Z" }];
    expect(parseStatuspage({ status, components: far, maintenances }, { colos: ["SIN"] })).toMatchObject({ state: "info", indicator: "maintenance" });
    // Without the component list (that request failed) the overall indicator still counts.
    expect(parseStatuspage({ status }, { colos: ["SIN"] })).toMatchObject({ state: "err", description: "Partial System Outage" });
  });
});

describe("parseStatusIo", () => {
  it("maps Status.io codes", () => {
    const body = (code: number, status: string) => ({ result: { status_overall: { status, status_code: code }, incidents: [], maintenance: { active: [], upcoming: [] } } });
    expect(parseStatusIo(body(100, "Operational"))).toMatchObject({ state: "ok", description: "Operational" });
    expect(parseStatusIo(body(200, "Planned Maintenance"))?.state).toBe("info");
    expect(parseStatusIo(body(400, "Partial Service Disruption"))?.state).toBe("warn");
    expect(parseStatusIo(body(500, "Service Disruption"))?.state).toBe("err");
    expect(parseStatusIo({ nope: 1 })).toBeNull();
  });
});

describe("parseGoogle", () => {
  const inc = (o: object) => ({ id: "i", begin: "2026-10-13T10:00:00+00:00", external_desc: "Firestore errors", status_impact: "SERVICE_DISRUPTION", severity: "medium",
    affected_products: [{ title: "Cloud Firestore", id: "x" }], uri: "incidents/i", ...o });
  it("counts only ongoing incidents", () => {
    expect(parseGoogle([inc({ end: "2026-10-13T11:00:00+00:00" })], now)).toMatchObject({ state: "ok", description: "No open incidents" });
    expect(parseGoogle([inc({})], now)).toMatchObject({ state: "warn", description: "Firestore errors",
      incidents: [{ name: "Firestore errors", impact: "SERVICE_DISRUPTION", startedAt: "2026-10-13T10:00:00+00:00", url: "https://status.cloud.google.com/incidents/i" }] });
    expect(parseGoogle([inc({ status_impact: "SERVICE_OUTAGE" })], now)?.state).toBe("err");
  });
  it("keeps unrelated Google Cloud incidents out of the state", () => {
    const r = parseGoogle([inc({ affected_products: [{ title: "Cloud Storage", id: "s" }], external_desc: "GCS latency" })], now, { relevant: /firestore|firebase|identity|monitoring/i });
    expect(r).toMatchObject({ state: "ok", description: "No incidents affecting Firebase (1 elsewhere)" });
  });
  it("points a Firebase incident at the Firebase status page", () => {
    const r = parseGoogle([inc({})], now, { host: "status.firebase.google.com" });
    expect(r?.incidents[0].url).toBe("https://status.firebase.google.com/incidents/i");
  });
});

describe("readFeed", () => {
  it("reads Cloudflare from its three small endpoints", async () => {
    server.use(
      http.get("https://www.cloudflarestatus.com/api/v2/status.json", () => HttpResponse.json({ status: { indicator: "none", description: "All Systems Operational" } })),
      http.get("https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json", () => HttpResponse.json({ incidents: [] })),
      http.get("https://www.cloudflarestatus.com/api/v2/scheduled-maintenances/active.json", () => HttpResponse.json({ scheduled_maintenances: [] })),
      http.get("https://www.cloudflarestatus.com/api/v2/components.json", () => HttpResponse.json({ components: [{ name: "La Paz, Bolivia - (LPB)", status: "major_outage" }] })),
    );
    expect(await readFeed("cloudflare", now)).toEqual({ ok: true, reading: { provider: "cloudflare", state: "ok", indicator: "none", description: "No open incidents near SIN, CGK", incidents: [] } });
  });
  it("reports a failing feed without throwing", async () => {
    server.use(http.get("https://www.vercel-status.com/api/v2/summary.json", () => new HttpResponse(null, { status: 503 })));
    expect(await readFeed("vercel", now)).toEqual({ ok: false, error: "The Vercel status feed answered 503." });
  });
  it("rejects an answer that isn't the expected JSON", async () => {
    server.use(http.get("https://status.supabase.com/api/v2/summary.json", () => HttpResponse.text("<html>")));
    expect(await readFeed("supabase", now)).toEqual({ ok: false, error: "The Supabase status feed answered in a format the console doesn't recognise." });
  });
  it("reads Firebase with its own host in incident links", async () => {
    server.use(http.get("https://status.firebase.google.com/incidents.json", () => HttpResponse.json([
      { id: "i", begin: "2026-10-13T10:00:00+00:00", external_desc: "Auth errors", status_impact: "SERVICE_DISRUPTION", affected_products: [{ title: "Firebase Authentication" }], uri: "incidents/i" },
    ])));
    const r = await readFeed("firebase", now);
    expect(r.ok && r.reading.incidents[0].url).toBe("https://status.firebase.google.com/incidents/i");
  });
});
