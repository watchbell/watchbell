import { describe, expect, it } from "vitest";
import { demuxLogs, isContainerRef, parseContainers, parseInspect, parseStats, selfContainerId } from "./parse";

const ID = "a".repeat(64);
const row = (o: object = {}) => ({
  Id: ID, Names: ["/web-1"], Image: "nginx:alpine", State: "running", Status: "Up 2 hours (healthy)", Created: 1_793_000_000,
  Ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }, { IP: "::", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }, { PrivatePort: 443, Type: "tcp" }],
  ...o,
});

describe("parseContainers", () => {
  it("keeps what the page shows", () => {
    expect(parseContainers([row()])).toEqual([{
      id: ID, name: "web-1", image: "nginx:alpine", state: "running", health: "healthy", status: "Up 2 hours (healthy)",
      ports: ["8080->80/tcp", "443/tcp"], created: new Date(1_793_000_000_000).toISOString(),
    }]);
  });
  it("reads every health word, or none", () => {
    expect(parseContainers([row({ Status: "Up 1 minute (unhealthy)" })])?.[0].health).toBe("unhealthy");
    expect(parseContainers([row({ Status: "Up 5 seconds (health: starting)" })])?.[0].health).toBe("starting");
    expect(parseContainers([row({ Status: "Exited (0) 3 days ago" })])?.[0].health).toBeNull();
  });
  it("lists trouble first, then running, then the rest by name", () => {
    const list = parseContainers([
      row({ Id: "b".repeat(64), Names: ["/zed"], State: "exited", Status: "Exited (1)" }),
      row({ Id: "c".repeat(64), Names: ["/api"], State: "running", Status: "Up" }),
      row({ Id: "d".repeat(64), Names: ["/loop"], State: "restarting", Status: "Restarting (1) 2 seconds ago" }),
      row({ Id: "e".repeat(64), Names: ["/db"], State: "running", Status: "Up (unhealthy)" }),
    ]);
    expect(list?.map((c) => c.name)).toEqual(["db", "loop", "api", "zed"]);
  });
  it("is null for an answer that isn't a list, and skips rows that aren't containers", () => {
    expect(parseContainers({ message: "x" })).toBeNull();
    expect(parseContainers([{ Id: "not-hex" }, row()])).toHaveLength(1);
  });
});

describe("demuxLogs", () => {
  const frame = (stream: number, text: string) => {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  };
  it("reads stdout and stderr frames as lines", () => {
    expect(demuxLogs(Buffer.concat([frame(1, "one\ntwo\n"), frame(2, "oops\n")]), false)).toEqual(["one", "two", "oops"]);
  });
  it("reads a TTY container's plain stream", () => {
    expect(demuxLogs(Buffer.from("a\r\nb\n"), true)).toEqual(["a", "b"]);
  });
  it("keeps what it can of a cut final frame", () => {
    const whole = frame(1, "first\n");
    const cut = frame(1, "second line\n").subarray(0, 12);
    expect(demuxLogs(Buffer.concat([whole, cut]), false)).toEqual(["first", "seco"]);
  });
  it("keeps the last 200 lines, each at most 2,000 characters", () => {
    const many = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const out = demuxLogs(Buffer.from(many), true);
    expect(out).toHaveLength(200);
    expect(out[0]).toBe("line 50");
    expect(demuxLogs(Buffer.from("x".repeat(5000)), true)[0]).toHaveLength(2000);
  });
});

describe("parseStats", () => {
  it("works out CPU and memory from one reading", () => {
    expect(parseStats({
      cpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
    })).toEqual({ cpuPct: 40, memBytes: 200, memLimit: 1000 });
  });
  it("is null where Docker gave nothing to work with", () => {
    expect(parseStats({})).toEqual({ cpuPct: null, memBytes: null, memLimit: null });
  });
});

describe("parseInspect", () => {
  it("reads the TTY flag and restart count", () => {
    expect(parseInspect({ Name: "/web-1", RestartCount: 3, Config: { Tty: true } })).toEqual({ name: "web-1", restarts: 3, tty: true });
    expect(parseInspect(null)).toBeNull();
  });
});

describe("isContainerRef", () => {
  it("accepts names and ids, refuses anything that could leave the path", () => {
    for (const ok of ["web-1", "my_app.v2", "a".repeat(12), ID]) expect(isContainerRef(ok)).toBe(true);
    for (const bad of ["../x", "a b", "", "-x", "x/y", "x?y", "a".repeat(129)]) expect(isContainerRef(bad)).toBe(false);
  });
});

describe("selfContainerId", () => {
  it("finds the container id Watchbell runs in, or null", () => {
    expect(selfContainerId(() => `0::/system.slice/docker-${ID}.scope\n`)).toBe(ID);
    expect(selfContainerId(() => "0::/user.slice/session-1.scope\n")).toBeNull();
    expect(selfContainerId(() => { throw new Error("no /proc"); })).toBeNull();
  });
});

describe("demuxLogs, minor fix M8", () => {
  it("decodes a character split across two frames", () => {
    const e = Buffer.from("é\n");
    const f = (b: Buffer) => { const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
    expect(demuxLogs(Buffer.concat([f(e.subarray(0, 1)), f(e.subarray(1))]), false)).toEqual(["é"]);
  });
});
