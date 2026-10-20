import type { ApiOp } from "@/private/openapi/operations";
import type { Builder } from "./request";

// Saved example requests (owner, 13 Oct): kept per endpoint in THIS browser's localStorage, never on the server and
// never the key. R10: an example holds the method's path values, query, headers MINUS Authorization (and Cookie), and
// the body; a heartbeat token is not kept either, and anything that looks like a console key or a heartbeat token is
// refused. Pure functions over a list; the component does the storage reads and writes (always in try/catch).

export const EXAMPLES_KEY = "watchpost.explorer.examples.v1";
export const MAX_EXAMPLES = 100;
export const MAX_NAME = 60;
export const MAX_BODY = 20_000;

export type SavedExample = {
  id: string; opId: string; name: string;
  path: Record<string, string>; query: Record<string, string>; headers: Record<string, string>; body: string; savedAt: string;
};

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const SECRET_LOOK = /\bw[bp]_[A-Za-z0-9]{20,}|\bhb_[0-9a-f]{32}\b|\bsk-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|\bgsk_[A-Za-z0-9]{20,}/;
export const looksLikeSecret = (text: string): boolean => SECRET_LOOK.test(text);

const isRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function valid(v: unknown): v is SavedExample {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.opId === "string" && typeof e.name === "string" && e.name.length > 0 && e.name.length <= MAX_NAME
    && isRecord(e.path) && isRecord(e.query) && isRecord(e.headers) && typeof e.body === "string" && e.body.length <= MAX_BODY && typeof e.savedAt === "string";
}

// A stored value that isn't what we wrote (edited by hand, an older shape) is dropped, not trusted.
export function parseExamples(raw: string | null): SavedExample[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(valid).filter((e) => !SECRET_LOOK.test(JSON.stringify(e))).slice(0, MAX_EXAMPLES) : [];
  } catch {
    return [];
  }
}

export const forOp = (list: SavedExample[], opId: string): SavedExample[] => list.filter((e) => e.opId === opId);

// The request as it is saved: values the person typed, without anything secret.
export function exampleFrom(op: ApiOp, b: Builder, name: string, id: string, now: Date): { ok: true; example: SavedExample } | { ok: false; error: string } {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the example a name." };
  if (clean.length > MAX_NAME) return { ok: false, error: `Use at most ${MAX_NAME} characters for the name.` };
  const secretParams = new Set(op.params.filter((p) => p.secret).map((p) => p.name));
  const path = Object.fromEntries(Object.entries(b.path).filter(([n, v]) => v.trim() && !secretParams.has(n)).map(([n, v]) => [n, v.trim()]));
  const query = Object.fromEntries(b.query.filter((r) => r.name.trim() && r.value.trim()).map((r) => [r.name.trim(), r.value.trim()]));
  const headers = Object.fromEntries(b.headers.filter((r) => r.name.trim() && r.value.trim() && !SENSITIVE_HEADERS.has(r.name.trim().toLowerCase())).map((r) => [r.name.trim(), r.value.trim()]));
  const body = b.body.trim();
  if (body.length > MAX_BODY) return { ok: false, error: "That body is too long to save as an example." };
  const example: SavedExample = { id, opId: op.id, name: clean, path, query, headers, body, savedAt: now.toISOString() };
  if (SECRET_LOOK.test(JSON.stringify(example))) return { ok: false, error: "That looks like a key or token. Remove it before saving; examples never keep secrets." };
  return { ok: true, example };
}

// Saving under a name the endpoint already has replaces that example.
export function saveExample(list: SavedExample[], ex: SavedExample): { ok: true; list: SavedExample[] } | { ok: false; error: string } {
  const same = list.find((e) => e.opId === ex.opId && e.name.toLowerCase() === ex.name.toLowerCase());
  if (!same && list.length >= MAX_EXAMPLES) return { ok: false, error: `You can keep ${MAX_EXAMPLES} examples. Delete one first.` };
  return { ok: true, list: same ? list.map((e) => (e === same ? { ...ex, id: same.id } : e)) : [...list, ex] };
}

export function renameExample(list: SavedExample[], id: string, name: string): { ok: true; list: SavedExample[] } | { ok: false; error: string } {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the example a name." };
  if (clean.length > MAX_NAME) return { ok: false, error: `Use at most ${MAX_NAME} characters for the name.` };
  const target = list.find((e) => e.id === id);
  if (!target) return { ok: false, error: "That example is gone." };
  if (list.some((e) => e.id !== id && e.opId === target.opId && e.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: "This endpoint already has an example with that name." };
  return { ok: true, list: list.map((e) => (e.id === id ? { ...e, name: clean } : e)) };
}

export const deleteExample = (list: SavedExample[], id: string): SavedExample[] => list.filter((e) => e.id !== id);

// An example as the builder's input.
export const exampleInput = (e: SavedExample): { query: Record<string, string>; path: Record<string, string>; headers: Record<string, string>; body: string } =>
  ({ query: e.query, path: e.path, headers: e.headers, body: e.body });
