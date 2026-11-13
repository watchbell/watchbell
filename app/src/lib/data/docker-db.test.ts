import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@/lib/docker/client";
import { containerDetailFor, dockerState, type DockerDeps, loadContainers, runContainerAction } from "./docker-db";

const ID = "a".repeat(64);
const SELF = "b".repeat(64);
const list = [
  { Id: ID, Names: ["/web"], Image: "nginx", State: "running", Status: "Up" },
  { Id: SELF, Names: ["/watchbell"], Image: "watchbell", State: "running", Status: "Up" },
];

function deps(o: Partial<DockerDeps> & { answers?: Record<string, { status: number; body: unknown }> } = {}) {
  const seen: string[] = [];
  const t: Transport = async (method, path) => {
    seen.push(`${method} ${path}`);
    const a = Object.entries(o.answers ?? {
      "GET /containers/json": { status: 200, body: list },
      [`GET /containers/${ID}/json`]: { status: 200, body: { Name: "/web", RestartCount: 0, Config: { Tty: true } } },
      [`GET /containers/${ID}/logs`]: { status: 200, body: "ok\nAPI_TOKEN=sk_live_abcdefghijklmnop\n" },
      [`GET /containers/${ID}/stats`]: { status: 200, body: {} },
      [`POST /containers/${ID}/`]: { status: 204, body: "" },
    }).find(([k]) => `${method} ${path}`.startsWith(k))?.[1] ?? { status: 500, body: {} };
    return { status: a.status, body: Buffer.from(typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  const audit = vi.fn(async () => undefined);
  const d: DockerDeps = { state: () => "on", transport: () => t, selfId: () => SELF, audit, ...o };
  return { d, seen, audit };
}

describe("dockerState", () => {
  it("is off on cloud, off until switched on in self-host, and demo in the demo", () => {
    expect(dockerState({})).toBe("off-cloud");
    expect(dockerState({ WATCHBELL_MODE: "selfhost" })).toBe("off-switch");
    expect(dockerState({ WATCHBELL_MODE: "selfhost", WATCHBELL_DOCKER: "on" })).toBe("on");
    expect(dockerState({ WATCHBELL_MODE: "selfhost", WATCHBELL_DOCKER: "yes" })).toBe("off-switch");
    expect(dockerState({ WATCHBELL_MODE: "demo" })).toBe("demo");
  });
});

describe("loadContainers", () => {
  it("lists containers and marks Watchbell's own", async () => {
    const r = await loadContainers(deps().d);
    expect(r.ok && r.data.containers.map((c) => [c.name, c.self])).toEqual([["watchbell", true], ["web", false]]);
  });
  it("says why when Docker is off or can't be read", async () => {
    expect(await loadContainers(deps({ state: () => "off-cloud" }).d)).toEqual({ ok: false, error: "Containers are part of the self-hosted edition." });
    expect(await loadContainers(deps({ state: () => "off-switch" }).d)).toEqual({ ok: false, error: "Set WATCHBELL_DOCKER=on in app/.env and give Watchbell access to the Docker socket, then restart Watchbell." });
    expect(await loadContainers(deps({ answers: {} }).d)).toEqual({ ok: false, error: "Docker answered HTTP 500." });
  });
  it("turns a socket path refusal into the same kind of answer", async () => {
    const r = await loadContainers(deps({ transport: () => { throw new Error("Watchbell only talks to Docker over a local socket."); } }).d);
    expect(r).toEqual({ ok: false, error: "Watchbell only talks to Docker over a local socket." });
  });
});

describe("containerDetailFor", () => {
  it("masks secret-looking values in the logs", async () => {
    const r = await containerDetailFor(ID, deps().d);
    expect(r.ok && r.data.logs[0]).toBe("ok");
    expect(r.ok && r.data.logs[1]).not.toContain("sk_live_abcdefghijklmnop");
  });
});

describe("runContainerAction", () => {
  const actor = { userId: "user-1" };
  it("restarts a container when the typed name matches, and audits it", async () => {
    const { d, seen, audit } = deps();
    expect(await runContainerAction(actor, ID, "restart", "web", d)).toEqual({ ok: true, message: "web restarted." });
    expect(seen).toContain(`POST /containers/${ID}/restart?t=10`);
    expect(audit).toHaveBeenCalledWith({ kind: "ok", message: "Container web: restart", resourceId: null, actorUserId: "user-1" });
  });
  it("starts without a typed name", async () => {
    expect(await runContainerAction(actor, ID, "start", "", deps().d)).toEqual({ ok: true, message: "web started." });
  });
  it("refuses a wrong typed name, Watchbell's own container and an unknown one, without writing", async () => {
    const { d, seen } = deps();
    expect(await runContainerAction(actor, ID, "stop", "wbe", d)).toEqual({ ok: false, error: "Type the container's name (web) to confirm." });
    expect(await runContainerAction(actor, SELF, "stop", "watchbell", d)).toEqual({ ok: false, error: "That's the container Watchbell runs in." });
    expect(await runContainerAction(actor, "c".repeat(64), "start", "", d)).toEqual({ ok: false, error: "That container doesn't exist any more." });
    expect(seen.filter((s) => s.startsWith("POST"))).toEqual([]);
  });
  it("audits a failed action", async () => {
    const { d, audit } = deps({ answers: { "GET /containers/json": { status: 200, body: list }, [`POST /containers/${ID}/`]: { status: 500, body: {} } } });
    expect(await runContainerAction(actor, ID, "start", "", d)).toEqual({ ok: false, error: "Docker answered HTTP 500." });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "Container web: start" }));
  });
});

describe("review fix M7", () => {
  it("masks secrets on log lines that start with Docker's timestamp", async () => {
    const r = await containerDetailFor(ID, deps({ answers: {
      "GET /containers/json": { status: 200, body: list },
      [`GET /containers/${ID}/json`]: { status: 200, body: { Name: "/web", RestartCount: 0, Config: { Tty: true } } },
      [`GET /containers/${ID}/logs`]: { status: 200, body: "2026-11-11T08:00:00.123456789Z DATABASE_URL=postgres://u:p4ssw0rd@db/x\n" },
      [`GET /containers/${ID}/stats`]: { status: 200, body: {} },
    } }).d);
    expect(r.ok && r.data.logs[0]).toMatch(/^2026-11-11T08:00:00\.123456789Z DATABASE_URL=/);
    expect(r.ok && r.data.logs[0]).not.toContain("p4ssw0rd");
  });
});

describe("minor fix M7", () => {
  it("masks key=value secrets in logfmt lines too", async () => {
    const r = await containerDetailFor(ID, deps({ answers: {
      "GET /containers/json": { status: 200, body: list },
      [`GET /containers/${ID}/json`]: { status: 200, body: { Name: "/web", RestartCount: 0, Config: { Tty: true } } },
      [`GET /containers/${ID}/logs`]: { status: 200, body: "2026-11-11T08:00:00Z level=info api_key=abc123xyz789 password=hunter22 user=bob\n" },
      [`GET /containers/${ID}/stats`]: { status: 200, body: {} },
    } }).d);
    const line = r.ok ? r.data.logs[0] : "";
    expect(line).not.toContain("abc123xyz789");
    expect(line).not.toContain("hunter22");
    expect(line).toContain("user=bob");
  });
});
