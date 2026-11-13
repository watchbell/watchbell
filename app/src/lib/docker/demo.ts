import type { ContainerDetail } from "./client";
import type { Container } from "./parse";

// Watchbell 1.5 Containers in demo mode: made-up containers and one made-up detail, so the page shows without a
// Docker daemon. Pure.

const id = (c: string) => c.repeat(64);
const created = "2026-11-01T08:00:00.000Z";

export const DEMO_CONTAINERS: (Container & { self: boolean })[] = [
  { id: id("1"), name: "queue-worker", image: "acme/worker:2.3", state: "running", health: "unhealthy", status: "Up 3 hours (unhealthy)", ports: [], created, self: false },
  { id: id("2"), name: "storefront", image: "acme/storefront:latest", state: "running", health: "healthy", status: "Up 2 days (healthy)", ports: ["3000->3000/tcp"], created, self: false },
  { id: id("3"), name: "redis", image: "redis:7-alpine", state: "running", health: null, status: "Up 2 days", ports: ["6379/tcp"], created, self: false },
  { id: id("4"), name: "nightly-backup", image: "acme/backup:1.0", state: "exited", health: null, status: "Exited (0) 9 hours ago", ports: [], created, self: false },
];

export const DEMO_DETAIL: ContainerDetail = {
  name: "queue-worker", restarts: 4,
  logs: [
    "2026-11-11T08:00:01.120Z worker started, 4 jobs waiting",
    "2026-11-11T08:00:03.441Z job 1182 sent the receipt email",
    "2026-11-11T08:00:09.902Z job 1183 failed: connect ETIMEDOUT smtp.example.com:587",
    "2026-11-11T08:00:10.004Z health check failed: queue lag 312 s (limit 120 s)",
  ],
  stats: { cpuPct: 41.5, memBytes: 187_000_000, memLimit: 512_000_000 },
};
