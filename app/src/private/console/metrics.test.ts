import { describe, expect, it } from "vitest";
import { metricsText } from "./metrics";
import type { SnapshotMonitor } from "./snapshot";

// 1.8.5: GET /api/v1/metrics (read:status) in the Prometheus text format, built from the same scrubbed snapshot as
// /api/v1/status, so a Prometheus or Grafana Cloud scrape sees the monitors and open alerts.
const mon = (o: Partial<SnapshotMonitor> = {}): SnapshotMonitor => ({
  app: "Toko utama", path: "/", kind: "http", state: "up", lastStatus: 200, latencyMs: 250, uptime30d: 99.85, lastCheckedAt: "2026-11-24T00:00:00.000Z",
  workspace: "Personal", ...o,
});
const LABELS = 'app="Toko utama",path="/",kind="http",workspace="Personal"';
const line = (s: string) => `${s}\n`;

describe("metricsText", () => {
  it("writes up, degraded, latency in seconds and uptime as a 0–1 ratio, with HELP and TYPE once each", () => {
    const t = metricsText({ monitors: [mon(), mon({ path: "/api", state: "degraded", latencyMs: 1200, uptime30d: 97.5 })], alertsBySeverity: {} });
    expect(t).toContain(line(`watchbell_monitor_up{${LABELS}} 1`));
    expect(t).toContain(line(`watchbell_monitor_degraded{${LABELS}} 0`));
    expect(t).toContain(line(`watchbell_monitor_latency_seconds{${LABELS}} 0.25`));
    expect(t).toContain(line(`watchbell_monitor_uptime_ratio{${LABELS},window="30d"} 0.9985`));
    expect(t).toContain(line('watchbell_monitor_up{app="Toko utama",path="/api",kind="http",workspace="Personal"} 1'));
    expect(t).toContain(line('watchbell_monitor_degraded{app="Toko utama",path="/api",kind="http",workspace="Personal"} 1'));
    for (const name of ["watchbell_monitor_up", "watchbell_monitor_degraded", "watchbell_monitor_latency_seconds", "watchbell_monitor_uptime_ratio", "watchbell_alerts_open"]) {
      expect(t.split(line(`# TYPE ${name} gauge`))).toHaveLength(2);
      expect(t.split(`# HELP ${name} `)).toHaveLength(2);
    }
    expect(t.endsWith("\n")).toBe(true);
  });

  it("a down monitor is 0; paused and unknown monitors are left out; missing numbers are left out", () => {
    const t = metricsText({ monitors: [mon({ state: "down", latencyMs: null, uptime30d: null }), mon({ path: "/p", state: "paused" }), mon({ path: "/u", state: "unknown" })], alertsBySeverity: {} });
    expect(t).toContain(line(`watchbell_monitor_up{${LABELS}} 0`));
    expect(t).not.toMatch(/path="\/p"|path="\/u"/);
    expect(t).not.toContain("watchbell_monitor_latency_seconds{");
    expect(t).not.toContain("watchbell_monitor_uptime_ratio{");
  });

  it("counts open alerts by severity", () => {
    const t = metricsText({ monitors: [], alertsBySeverity: { warning: 1, critical: 2 } });
    expect(t).toContain(line('watchbell_alerts_open{severity="critical"} 2'));
    expect(t).toContain(line('watchbell_alerts_open{severity="warning"} 1'));
  });

  it("escapes label values", () => {
    const t = metricsText({ monitors: [mon({ app: 'Kopi "Senja"\\Toko\nBaru' })], alertsBySeverity: {} });
    expect(t).toContain('app="Kopi \\"Senja\\"\\\\Toko\\nBaru"');
  });

  // Final review 1.8.5 I1: two monitors with the same labels (www and apex both on "/", two checks of /api/health)
  // were cut to the first one, so a down monitor could hide behind an up one. They merge to the worst reading.
  it("merges monitors with the same labels to their worst reading, in one series", () => {
    const t = metricsText({
      monitors: [
        mon({ state: "up", latencyMs: 100, uptime30d: 100 }),
        mon({ state: "down", latencyMs: 900, uptime30d: 90 }),
        mon({ state: "degraded", latencyMs: 300, uptime30d: 95 }),
      ],
      alertsBySeverity: {},
    });
    expect(t.match(/^watchbell_monitor_up\{/gm)).toHaveLength(1);
    expect(t).toContain(line(`watchbell_monitor_up{${LABELS}} 0`));
    expect(t).toContain(line(`watchbell_monitor_degraded{${LABELS}} 1`));
    expect(t).toContain(line(`watchbell_monitor_latency_seconds{${LABELS}} 0.9`));
    expect(t).toContain(line(`watchbell_monitor_uptime_ratio{${LABELS},window="30d"} 0.9`));
  });

  // Final review 1.8.5 M6: with nothing open there were no alert series at all, so rules needed "or vector(0)".
  it("writes every severity, 0 when none is open", () => {
    const t = metricsText({ monitors: [], alertsBySeverity: { critical: 2 } });
    expect(t).toContain(line('watchbell_alerts_open{severity="critical"} 2'));
    expect(t).toContain(line('watchbell_alerts_open{severity="warning"} 0'));
    expect(t).toContain(line('watchbell_alerts_open{severity="info"} 0'));
  });

  it("leaves the workspace label out when the console has none", () => {
    const t = metricsText({ monitors: [mon({ workspace: undefined })], alertsBySeverity: {} });
    expect(t).toContain(line('watchbell_monitor_up{app="Toko utama",path="/",kind="http"} 1'));
  });
});
