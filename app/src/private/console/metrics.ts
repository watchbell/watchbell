import { SEVERITIES } from "@/db/schema";
import type { SnapshotMonitor } from "./snapshot";

// 1.8.5: the console's monitors and open alerts in the Prometheus text format (version 0.0.4), for GET /api/v1/metrics.
// Built from the scrubbed snapshot /api/v1/status already serves, so the labels are the app's display name, the
// monitor's path, its kind and the workspace name: never a URL, an error text or a provider. Paused and unknown
// monitors are left out (there is no reading to report); a missing latency or uptime leaves that one sample out.
// Monitors that share their labels (www and apex both on "/", two checks of /api/health) are one series holding the
// worst reading of the group, so a down monitor never hides behind an up one (final review 1.8.5 I1).

type Gauge = { name: string; help: string; samples: string[] };
type Reading = { down: boolean; degraded: boolean; latencyMs: number | null; uptime: number | null };

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels: Record<string, string | undefined>) =>
  Object.entries(labels).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${escape(v as string)}"`).join(",");
const worse = (a: number | null, b: number | null, pick: (x: number, y: number) => number) => (a === null ? b : b === null ? a : pick(a, b));

export function metricsText(s: { monitors: SnapshotMonitor[]; alertsBySeverity: Record<string, number> }): string {
  const up: Gauge = { name: "watchbell_monitor_up", help: "1 when the last check passed (up or degraded), 0 when the monitor is down.", samples: [] };
  const degraded: Gauge = { name: "watchbell_monitor_degraded", help: "1 when the monitor answers but slowly or with warnings.", samples: [] };
  const latency: Gauge = { name: "watchbell_monitor_latency_seconds", help: "Response time of the last check, in seconds.", samples: [] };
  const uptime: Gauge = { name: "watchbell_monitor_uptime_ratio", help: "Share of successful checks over the window, from 0 to 1.", samples: [] };
  const alerts: Gauge = { name: "watchbell_alerts_open", help: "Open alerts by severity.", samples: [] };

  const series = new Map<string, Reading>();
  for (const m of s.monitors) {
    if (m.state !== "up" && m.state !== "degraded" && m.state !== "down") continue;
    const labels = labelText({ app: m.app, path: m.path, kind: m.kind, workspace: m.workspace });
    const r: Reading = { down: m.state === "down", degraded: m.state === "degraded", latencyMs: m.latencyMs, uptime: m.uptime30d };
    const had = series.get(labels);
    series.set(labels, had ? {
      down: had.down || r.down, degraded: had.degraded || r.degraded,
      latencyMs: worse(had.latencyMs, r.latencyMs, Math.max), uptime: worse(had.uptime, r.uptime, Math.min),
    } : r);
  }
  for (const [labels, r] of series) {
    up.samples.push(`${up.name}{${labels}} ${r.down ? 0 : 1}`);
    degraded.samples.push(`${degraded.name}{${labels}} ${r.degraded ? 1 : 0}`);
    if (r.latencyMs !== null) latency.samples.push(`${latency.name}{${labels}} ${r.latencyMs / 1000}`);
    if (r.uptime !== null) uptime.samples.push(`${uptime.name}{${labels},window="30d"} ${Math.round(r.uptime * 100) / 10000}`);
  }

  // Every severity is written, 0 when none is open, so a rule needs no "or vector(0)" (final review 1.8.5 M6).
  const severities = [...new Set<string>([...SEVERITIES, ...Object.keys(s.alertsBySeverity)])].sort();
  for (const severity of severities) alerts.samples.push(`${alerts.name}{${labelText({ severity })}} ${s.alertsBySeverity[severity] ?? 0}`);

  return [up, degraded, latency, uptime, alerts]
    .map((g) => [`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, ...g.samples].join("\n"))
    .join("\n") + "\n";
}
