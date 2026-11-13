import { describe, expect, it } from "vitest";
import { containerAction, containerDetail, listContainers, socketPathFor, type Transport } from "./client";

const ID = "a".repeat(64);

function fake(answers: Record<string, { status: number; body: unknown }>): Transport & { seen: string[] } {
  const seen: string[] = [];
  const t = (async (method: "GET" | "POST", path: string) => {
    seen.push(`${method} ${path}`);
    const key = Object.keys(answers).find((k) => path.startsWith(k.split(" ")[1]) && k.startsWith(method));
    const a = key ? answers[key] : { status: 500, body: { message: "boom" } };
    return { status: a.status, body: Buffer.isBuffer(a.body) ? a.body : Buffer.from(JSON.stringify(a.body)) };
  }) as Transport & { seen: string[] };
  t.seen = seen;
  return t;
}

describe("socketPathFor", () => {
  it("uses the platform's local socket", () => {
    expect(socketPathFor({}, "linux")).toBe("/var/run/docker.sock");
    expect(socketPathFor({}, "darwin")).toBe("/var/run/docker.sock");
    expect(socketPathFor({}, "win32")).toBe("\\\\.\\pipe\\docker_engine");
  });
  it("follows DOCKER_HOST when it names a local socket", () => {
    expect(socketPathFor({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }, "linux")).toBe("/run/user/1000/docker.sock");
    expect(socketPathFor({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }, "win32")).toBe("\\\\.\\pipe\\docker_engine");
  });
  it("refuses a remote daemon", () => {
    expect(() => socketPathFor({ DOCKER_HOST: "tcp://10.0.0.5:2375" }, "linux")).toThrow("Watchbell only talks to Docker over a local socket.");
    expect(() => socketPathFor({ DOCKER_HOST: "ssh://me@host" }, "linux")).toThrow("Watchbell only talks to Docker over a local socket.");
  });
});

describe("listContainers", () => {
  it("lists every container", async () => {
    const t = fake({ "GET /containers/json": { status: 200, body: [{ Id: ID, Names: ["/web"], State: "running", Status: "Up" }] } });
    const r = await listContainers(t);
    expect(t.seen).toEqual(["GET /containers/json?all=1"]);
    expect(r.ok && r.data.map((c) => c.name)).toEqual(["web"]);
  });
  it("says so when Docker answers with an error", async () => {
    expect(await listContainers(fake({}))).toEqual({ ok: false, error: "Docker answered HTTP 500." });
  });
  it("turns a transport failure into a sentence", async () => {
    const t: Transport = async () => { throw Object.assign(new Error("connect EACCES /var/run/docker.sock"), { code: "EACCES" }); };
    expect(await listContainers(t)).toEqual({ ok: false, error: "Watchbell can't open the Docker socket (EACCES). Add the user that runs Watchbell to the docker group, then restart Watchbell." });
  });
});

describe("containerDetail", () => {
  it("reads the logs the right way for a non-TTY container, and the stats", async () => {
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt32BE(6, 4);
    const t = fake({
      [`GET /containers/${ID}/json`]: { status: 200, body: { Name: "/web", RestartCount: 2, Config: { Tty: false } } },
      [`GET /containers/${ID}/logs`]: { status: 200, body: Buffer.concat([head, Buffer.from("hello\n")]) },
      [`GET /containers/${ID}/stats`]: { status: 200, body: { memory_stats: { usage: 10, limit: 100 } } },
    });
    const r = await containerDetail(t, ID);
    expect(r).toEqual({ ok: true, data: { name: "web", restarts: 2, logs: ["hello"], stats: { cpuPct: null, memBytes: 10, memLimit: 100 } } });
    expect(t.seen).toContain(`GET /containers/${ID}/logs?stdout=1&stderr=1&tail=200&timestamps=1`);
    expect(t.seen).toContain(`GET /containers/${ID}/stats?stream=false`);
  });
  it("refuses a reference that isn't one before asking Docker", async () => {
    const t = fake({});
    expect(await containerDetail(t, "../etc")).toEqual({ ok: false, error: "That isn't a container." });
    expect(t.seen).toEqual([]);
  });
  it("says when the container is gone", async () => {
    expect(await containerDetail(fake({ [`GET /containers/${ID}/json`]: { status: 404, body: {} } }), ID)).toEqual({ ok: false, error: "That container doesn't exist any more." });
  });
});

describe("containerAction", () => {
  it("posts start, stop and restart, and nothing else", async () => {
    for (const action of ["start", "stop", "restart"] as const) {
      const t = fake({ [`POST /containers/${ID}/${action}`]: { status: 204, body: "" } });
      expect(await containerAction(t, ID, action)).toEqual({ ok: true });
      expect(t.seen).toEqual([`POST /containers/${ID}/${action}${action === "start" ? "" : "?t=10"}`]);
    }
    expect(await containerAction(fake({}), ID, "remove" as never)).toEqual({ ok: false, error: "That isn't something Watchbell does to containers." });
  });
  it("reads 304 (already in that state) as done", async () => {
    expect(await containerAction(fake({ [`POST /containers/${ID}/start`]: { status: 304, body: "" } }), ID, "start")).toEqual({ ok: true });
  });
});

describe("review fixes I2, I3", () => {
  it("gives stop and restart time to finish (Docker waits up to 10 s)", async () => {
    const seen: [string, number | undefined][] = [];
    const t: Transport = async (_m, path, timeoutMs) => { seen.push([path, timeoutMs]); return { status: 204, body: Buffer.alloc(0) }; };
    await containerAction(t, ID, "stop");
    await containerAction(t, ID, "start");
    expect(seen).toEqual([[`/containers/${ID}/stop?t=10`, 25_000], [`/containers/${ID}/start`, 25_000]]);
  });
});

describe("minor fix M9", () => {
  it("asks for fewer log lines when 200 are too large to read", async () => {
    const seen: string[] = [];
    const t: Transport = async (_m, path) => {
      seen.push(path);
      if (path.includes("/json")) return { status: 200, body: Buffer.from(JSON.stringify({ Name: "/w", RestartCount: 0, Config: { Tty: true } })) };
      if (path.includes("tail=200")) throw new Error("Docker sent too large an answer");
      if (path.includes("/logs")) return { status: 200, body: Buffer.from("last line\n") };
      return { status: 200, body: Buffer.from("{}") };
    };
    const r = await containerDetail(t, ID);
    expect(r.ok && r.data.logs).toEqual(["(only the last 40 lines: the full tail was too large)", "last line"]);
    expect(seen.some((p) => p.includes("tail=40"))).toBe(true);
  });
});
