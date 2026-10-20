// The scrubbed console data the console's own AI, MCP and /api/v1/status share (R5). Built only by consoleSnapshot()
// (Task 5): no emails, URLs (monitor paths only), IPs, tokens, connection strings or database names (aliases).
export type SnapshotApp = {
  id: string;
  state: "running" | "degraded" | "down" | "building" | "paused" | "unknown";
  uptime30d: number | null;
  database: string | null;
  lastDeploy: string | null;
  problems: { kind: string; where: string; what: string; fix: string | null }[];
};

export type ConsoleSnapshot = {
  generatedAt: string;
  apps: SnapshotApp[];
  monitors: { up: number; degraded: number; down: number; paused: number; items?: unknown[] };
  alerts: { open: number; critical: number; items?: unknown[] };
  advisor?: { title: string; app: string; severity: string }[];
};
