import { request } from "node:http";
import { type Container, demuxLogs, isContainerRef, LOG_LINES, parseContainers, parseInspect, parseStats, type Stats } from "./parse";

// Watchbell 1.5 Docker on the host (10c, self-host only): the Docker Engine API over the local socket — never TCP. The
// transport is injected so the tests need no daemon. Reads: the container list, one container's details, its logs
// tail and one stats reading. Writes: start, stop, restart only. Nothing here throws.

// timeoutMs: per call; stop and restart wait for the container (review I2).
export type Transport = (method: "GET" | "POST", path: string, timeoutMs?: number) => Promise<{ status: number; body: Buffer }>;
export type DockerResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type ContainerDetail = { name: string; restarts: number; logs: string[]; stats: Stats };
export type ContainerVerb = "start" | "stop" | "restart";

// No version prefix: the daemon answers in its own current API version, so a newer Docker that drops old API versions
// keeps working (review I3). The fields read here are stable across versions.
const API = "";
const TIMEOUT_MS = 5_000;
// Docker answers stop and restart only after the container stopped: up to t=10 s, then a kill.
const ACTION_TIMEOUT_MS = 25_000;
const FEWER_LOG_LINES = 40;
const MAX_BYTES = 1024 * 1024;
const REMOTE = "Watchbell only talks to Docker over a local socket.";
const VERBS = new Set<ContainerVerb>(["start", "stop", "restart"]);

export function socketPathFor(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  const host = env.DOCKER_HOST?.trim();
  if (host) {
    if (host.startsWith("unix://")) return host.slice("unix://".length);
    if (host.startsWith("npipe://")) return host.slice("npipe://".length).replace(/\//g, "\\");
    throw new Error(REMOTE);
  }
  return platform === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock";
}

export function socketTransport(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Transport {
  const socketPath = socketPathFor(env, platform);
  return (method, path, timeoutMs = TIMEOUT_MS) => new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path: API + path, headers: { Host: "docker" }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error("Docker sent too large an answer")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("Docker didn't answer in time"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

function why(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (code === "EACCES" || code === "EPERM") return `Watchbell can't open the Docker socket (${code}). Add the user that runs Watchbell to the docker group, then restart Watchbell.`;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "Docker isn't running on this machine (no socket answered).";
  if (code === "ETIMEDOUT") return "Docker didn't answer in time.";
  return `Docker couldn't be reached (${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}).`;
}

async function call(t: Transport, method: "GET" | "POST", path: string, timeoutMs?: number): Promise<DockerResult<Buffer>> {
  try {
    const r = await (timeoutMs === undefined ? t(method, path) : t(method, path, timeoutMs));
    if (r.status === 404) return { ok: false, error: "That container doesn't exist any more." };
    if (r.status >= 400) return { ok: false, error: `Docker answered HTTP ${r.status}.` };
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
}

const json = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return null;
  }
};

export async function listContainers(t: Transport): Promise<DockerResult<Container[]>> {
  const r = await call(t, "GET", "/containers/json?all=1");
  if (!r.ok) return r;
  const list = parseContainers(json(r.data));
  return list ? { ok: true, data: list } : { ok: false, error: "Docker's container list couldn't be read." };
}

export async function containerDetail(t: Transport, id: string): Promise<DockerResult<ContainerDetail>> {
  if (!isContainerRef(id)) return { ok: false, error: "That isn't a container." };
  const info = await call(t, "GET", `/containers/${id}/json`);
  if (!info.ok) return info;
  const inspect = parseInspect(json(info.data));
  if (!inspect) return { ok: false, error: "Docker's answer about that container couldn't be read." };
  const logsPath = (tail: number) => `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`;
  let logs = await call(t, "GET", logsPath(LOG_LINES));
  // 200 very long lines can pass the 1 MB cap; fewer lines beat no logs at all (M9).
  let fewer = false;
  if (!logs.ok && /too large/.test(logs.error)) {
    logs = await call(t, "GET", logsPath(FEWER_LOG_LINES));
    fewer = logs.ok;
  }
  const stats = await call(t, "GET", `/containers/${id}/stats?stream=false`);
  return {
    ok: true,
    data: {
      name: inspect.name, restarts: inspect.restarts,
      logs: logs.ok
        ? [...(fewer ? [`(only the last ${FEWER_LOG_LINES} lines: the full tail was too large)`] : []), ...demuxLogs(logs.data, inspect.tty)]
        : [`(logs couldn't be read: ${logs.error})`],
      stats: stats.ok ? parseStats(json(stats.data)) : { cpuPct: null, memBytes: null, memLimit: null },
    },
  };
}

// 204 done; 304 already in that state (also done).
export async function containerAction(t: Transport, id: string, verb: ContainerVerb): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!VERBS.has(verb)) return { ok: false, error: "That isn't something Watchbell does to containers." };
  if (!isContainerRef(id)) return { ok: false, error: "That isn't a container." };
  const r = await call(t, "POST", `/containers/${id}/${verb}${verb === "start" ? "" : "?t=10"}`, ACTION_TIMEOUT_MS);
  return r.ok ? { ok: true } : r;
}
