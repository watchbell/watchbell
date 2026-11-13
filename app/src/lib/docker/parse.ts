// Watchbell 1.5 Docker on the host (10c, self-host only): reading the Docker Engine API's answers. Only what the
// Containers page shows is kept. Pure; nothing here throws.

export type Health = "healthy" | "unhealthy" | "starting";
export type Container = {
  id: string; name: string; image: string; state: string; health: Health | null; status: string; ports: string[]; created: string;
};
export type ContainerInfo = { name: string; restarts: number; tty: boolean };
export type Stats = { cpuPct: number | null; memBytes: number | null; memLimit: number | null };

export const LOG_LINES = 200;
const LINE_MAX = 2_000;
const ID = /^[0-9a-f]{64}$/;
// A container name or id, checked before it goes into a request path.
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const isContainerRef = (v: string): boolean => REF.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function healthOf(status: string): Health | null {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  return !m ? null : m[1] === "health: starting" ? "starting" : (m[1] as Health);
}

// Trouble first (unhealthy, restarting), then running, then the rest; by name within each.
const rank = (c: Container) => (c.health === "unhealthy" || c.state === "restarting" ? 0 : c.state === "running" ? 1 : 2);

export function parseContainers(body: unknown): Container[] | null {
  if (!Array.isArray(body)) return null;
  const out: Container[] = [];
  for (const r of body) {
    if (!isObj(r) || typeof r.Id !== "string" || !ID.test(r.Id)) continue;
    const names = Array.isArray(r.Names) ? r.Names.filter((n): n is string => typeof n === "string") : [];
    const status = typeof r.Status === "string" ? r.Status.slice(0, 200) : "";
    const ports = new Set<string>();
    for (const p of Array.isArray(r.Ports) ? r.Ports : []) {
      if (!isObj(p) || num(p.PrivatePort) === null) continue;
      const type = typeof p.Type === "string" ? p.Type : "tcp";
      ports.add(num(p.PublicPort) !== null ? `${p.PublicPort}->${p.PrivatePort}/${type}` : `${p.PrivatePort}/${type}`);
    }
    const created = num(r.Created);
    out.push({
      id: r.Id, name: (names[0] ?? r.Id.slice(0, 12)).replace(/^\//, ""), image: typeof r.Image === "string" ? r.Image.slice(0, 200) : "",
      state: typeof r.State === "string" ? r.State : "unknown", health: healthOf(status), status, ports: [...ports],
      created: created !== null ? new Date(created * 1000).toISOString() : "",
    });
  }
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function parseInspect(body: unknown): ContainerInfo | null {
  if (!isObj(body)) return null;
  const config = isObj(body.Config) ? body.Config : {};
  return { name: typeof body.Name === "string" ? body.Name.replace(/^\//, "") : "", restarts: num(body.RestartCount) ?? 0, tty: config.Tty === true };
}

// The logs endpoint sends 8-byte frame headers (stream, 0, 0, 0, size big-endian) unless the container has a TTY.
// A frame cut short at the end keeps what arrived.
export function demuxLogs(buf: Buffer, tty: boolean): string[] {
  let text = "";
  if (tty) text = buf.toString("utf8");
  else {
    // Payloads are joined before decoding: Docker splits long lines across frames, sometimes inside a character (M8).
    const parts: Buffer[] = [];
    let at = 0;
    while (at + 8 <= buf.length) {
      const size = buf.readUInt32BE(at + 4);
      parts.push(buf.subarray(at + 8, Math.min(at + 8 + size, buf.length)));
      at += 8 + size;
    }
    text = Buffer.concat(parts).toString("utf8");
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-LOG_LINES).map((l) => l.slice(0, LINE_MAX));
}

// One stats reading (stream=false carries the previous sample in precpu_stats). Memory leaves out the page cache.
export function parseStats(body: unknown): Stats {
  if (!isObj(body)) return { cpuPct: null, memBytes: null, memLimit: null };
  const cpu = isObj(body.cpu_stats) ? body.cpu_stats : {};
  const pre = isObj(body.precpu_stats) ? body.precpu_stats : {};
  const total = (s: Obj) => (isObj(s.cpu_usage) ? num(s.cpu_usage.total_usage) : null);
  const cpuDelta = (total(cpu) ?? NaN) - (total(pre) ?? NaN);
  const sysDelta = (num(cpu.system_cpu_usage) ?? NaN) - (num(pre.system_cpu_usage) ?? NaN);
  const cpus = num(cpu.online_cpus) ?? 1;
  const cpuPct = cpuDelta >= 0 && sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : null;
  const mem = isObj(body.memory_stats) ? body.memory_stats : {};
  const usage = num(mem.usage);
  const stats = isObj(mem.stats) ? mem.stats : {};
  const cache = num(stats.inactive_file) ?? num(stats.cache) ?? 0;
  return { cpuPct, memBytes: usage !== null ? Math.max(0, usage - cache) : null, memLimit: num(mem.limit) };
}

// The container Watchbell itself runs in, from /proc/self/cgroup (or mountinfo); null outside a container.
export function selfContainerId(read: (path: string) => string): string | null {
  for (const path of ["/proc/self/cgroup", "/proc/self/mountinfo"]) {
    try {
      const m = /(?:docker[-/]|containers\/)([0-9a-f]{64})/.exec(read(path));
      if (m) return m[1];
    } catch {
      // not Linux, or no /proc
    }
  }
  return null;
}
