import "server-only";
import { readFileSync } from "node:fs";
import { redactCode } from "@/lib/code/redact";
import { recordAction } from "@/lib/data/audit-db";
import { containerAction, type ContainerDetail, containerDetail, type ContainerVerb, listContainers, socketTransport, type Transport } from "@/lib/docker/client";
import { type Container, selfContainerId } from "@/lib/docker/parse";
import { mode } from "@/lib/mode";

// Watchbell 1.5 Docker on the host (10c): DevOps › Containers. Self-host only and off until WATCHBELL_DOCKER=on, because
// the Docker socket is root-equivalent on the host. Read on page load and Refresh only. Logs are masked like code the
// AI reads. Actions: start, stop, restart — never on the container Watchbell itself runs in. The transport, the own
// container id and the audit are injected so the tests need no daemon or database.

export type DockerState = "off-cloud" | "off-switch" | "on" | "demo";
export type ListedContainer = Container & { self: boolean };

export const OFF_CLOUD = "Containers are part of the self-hosted edition.";
export const OFF_SWITCH = "Set WATCHBELL_DOCKER=on in app/.env and give Watchbell access to the Docker socket, then restart Watchbell.";

export function dockerState(env: Record<string, string | undefined> = process.env): DockerState {
  const m = mode(env);
  if (m === "cloud") return "off-cloud";
  if (m === "demo") return "demo";
  return env.WATCHBELL_DOCKER?.trim().toLowerCase() === "on" ? "on" : "off-switch";
}

export type DockerDeps = {
  state(): DockerState;
  transport(): Transport;
  selfId(): string | null;
  audit(e: { kind: "ok" | "err"; message: string; resourceId: null; actorUserId: string | null }): Promise<void>;
};

const DEFAULT_DEPS: DockerDeps = {
  state: () => dockerState(),
  transport: () => socketTransport(),
  selfId: () => selfContainerId((p) => readFileSync(p, "utf8")),
  audit: (e) => recordAction(e),
};

type Fail = { ok: false; error: string };

function open(deps: DockerDeps): { ok: true; t: Transport } | Fail {
  const s = deps.state();
  if (s === "off-cloud") return { ok: false, error: OFF_CLOUD };
  if (s === "off-switch") return { ok: false, error: OFF_SWITCH };
  try {
    return { ok: true, t: deps.transport() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Docker couldn't be reached." };
  }
}

export async function loadContainers(deps: DockerDeps = DEFAULT_DEPS): Promise<{ ok: true; data: { containers: ListedContainer[] } } | Fail> {
  const o = open(deps);
  if (!o.ok) return o;
  const r = await listContainers(o.t);
  if (!r.ok) return r;
  const self = deps.selfId();
  return { ok: true, data: { containers: r.data.map((c) => ({ ...c, self: c.id === self })) } };
}

// Unquoted logfmt (`api_key=abc password=x`) anywhere in a line, which the code redaction doesn't catch (M7).
const LOGFMT_SECRET = /\b([A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|cookie|session)[A-Za-z0-9_.-]*)=([^\s"']{3,})/gi;
const maskLine = (line: string): string => redactCode(line).replace(LOGFMT_SECRET, (_m, name) => `${name}=«redacted»`);

export async function containerDetailFor(id: string, deps: DockerDeps = DEFAULT_DEPS): Promise<{ ok: true; data: ContainerDetail } | Fail> {
  const o = open(deps);
  if (!o.ok) return o;
  const r = await containerDetail(o.t, id);
  if (!r.ok) return r;
  // Docker puts a timestamp before every line (timestamps=1), which hid line-start patterns like FOO_SECRET=… from the
  // redaction; each line is masked without it, then the timestamp goes back (review M7).
  const logs = r.data.logs.map((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}T\S+Z )([\s\S]*)$/.exec(line);
    return m ? m[1] + maskLine(m[2]) : maskLine(line);
  });
  return { ok: true, data: { ...r.data, logs } };
}

const DONE: Record<ContainerVerb, string> = { start: "started", stop: "stopped", restart: "restarted" };

// Stop and restart need the container's name typed back (typedName); start doesn't.
export async function runContainerAction(
  actor: { userId: string | null }, id: string, verb: ContainerVerb, typedName: string, deps: DockerDeps = DEFAULT_DEPS,
): Promise<{ ok: true; message: string } | Fail> {
  const o = open(deps);
  if (!o.ok) return o;
  const list = await listContainers(o.t);
  if (!list.ok) return list;
  const c = list.data.find((x) => x.id === id || x.name === id);
  if (!c) return { ok: false, error: "That container doesn't exist any more." };
  if (c.id === deps.selfId()) return { ok: false, error: "That's the container Watchbell runs in." };
  if (verb !== "start" && typedName.trim() !== c.name) return { ok: false, error: `Type the container's name (${c.name}) to confirm.` };
  const r = await containerAction(o.t, c.id, verb);
  await deps.audit({ kind: r.ok ? "ok" : "err", message: `Container ${c.name}: ${verb}`, resourceId: null, actorUserId: actor.userId });
  return r.ok ? { ok: true, message: `${c.name} ${DONE[verb]}.` } : r;
}
