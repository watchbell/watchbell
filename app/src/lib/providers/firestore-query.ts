import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Stage 9 slice 2: a read-only Firestore query builder over the REST API, with the Firebase account's existing service
// account (roles/datastore.viewer, which the health ping already uses: datastore.entities.get and .list). Two calls:
// documents:listCollectionIds (root collections; billed as one read) and documents:runQuery (one read per document
// returned, at least one per query). Nothing here writes; the viewer role couldn't anyway.

export const FS_OPS = {
  "==": "EQUAL", "!=": "NOT_EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL",
  "array-contains": "ARRAY_CONTAINS", in: "IN", "not-in": "NOT_IN", "array-contains-any": "ARRAY_CONTAINS_ANY",
} as const;
export type FsOp = keyof typeof FS_OPS;
export const FS_LIST_OPS: FsOp[] = ["in", "not-in", "array-contains-any"];
export const FS_TYPES = ["string", "number", "boolean", "null"] as const;
export type FsType = (typeof FS_TYPES)[number];

export const FS_MAX_LIMIT = 100;
export const FS_MAX_WHERE = 5;
const FS_MAX_LIST = 10;

const FIELD = /^(?:__name__|[A-Za-z_][A-Za-z0-9_]{0,99}(?:\.[A-Za-z_][A-Za-z0-9_]{0,99}){0,9})$/;
export const COLLECTION = /^(?!__.*__$)(?!\.\.?$)[^/\s][^/]{0,199}$/;

const querySchema = z.object({
  collection: z.string().regex(COLLECTION),
  where: z.array(z.object({
    field: z.string().regex(FIELD),
    op: z.enum(Object.keys(FS_OPS) as [FsOp, ...FsOp[]]),
    type: z.enum(FS_TYPES),
    value: z.string().max(500),
  })).max(FS_MAX_WHERE),
  orderBy: z.object({ field: z.string().regex(FIELD), dir: z.enum(["asc", "desc"]) }).nullable(),
  limit: z.number().int().min(1).max(FS_MAX_LIMIT),
});
export type FsQuery = z.infer<typeof querySchema>;

type FsValue = Record<string, unknown>;

function scalar(type: FsType, raw: string): FsValue | string {
  const v = raw.trim();
  if (type === "null") return { nullValue: null };
  if (type === "boolean") {
    if (v === "true" || v === "false") return { booleanValue: v === "true" };
    return "A boolean value must be true or false.";
  }
  if (type === "number") {
    const n = Number(v);
    if (!v || !Number.isFinite(n)) return `"${v.slice(0, 20)}" isn't a number.`;
    return Number.isSafeInteger(n) && !/[.eE]/.test(v) ? { integerValue: String(n) } : { doubleValue: n };
  }
  return { stringValue: raw };
}

// Builds the runQuery body from the page's form, or says what is wrong with it.
export function buildStructuredQuery(input: unknown): { ok: true; query: FsQuery; body: { structuredQuery: Record<string, unknown> } } | { ok: false; error: string } {
  const p = querySchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the collection, the fields (letters, digits, _ and dots) and a limit of 1 to 100." };
  const q = p.data;
  const filters: Record<string, unknown>[] = [];
  for (const w of q.where) {
    let value: FsValue;
    if (FS_LIST_OPS.includes(w.op)) {
      const parts = w.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (!parts.length || parts.length > FS_MAX_LIST) return { ok: false, error: `${w.op} takes 1 to ${FS_MAX_LIST} comma-separated values.` };
      const values: FsValue[] = [];
      for (const part of parts) {
        const v = scalar(w.type, part);
        if (typeof v === "string") return { ok: false, error: v };
        values.push(v);
      }
      value = { arrayValue: { values } };
    } else {
      const v = scalar(w.type, w.value);
      if (typeof v === "string") return { ok: false, error: v };
      value = v;
    }
    filters.push({ fieldFilter: { field: { fieldPath: w.field }, op: FS_OPS[w.op], value } });
  }
  const structuredQuery: Record<string, unknown> = { from: [{ collectionId: q.collection }], limit: q.limit };
  if (filters.length === 1) structuredQuery.where = filters[0];
  if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };
  if (q.orderBy) structuredQuery.orderBy = [{ field: { fieldPath: q.orderBy.field }, direction: q.orderBy.dir === "asc" ? "ASCENDING" : "DESCENDING" }];
  return { ok: true, query: q, body: { structuredQuery } };
}

// ---- reading the answer ----

export const FS_STRING_CAP = 300;
const FS_ARRAY_CAP = 20;
const FS_MAP_CAP = 50;
const FS_DEPTH = 5;
export const FS_PAYLOAD_CAP = 400_000;

const clip = (s: string) => (s.length > FS_STRING_CAP ? `${s.slice(0, FS_STRING_CAP)}… (${s.length} chars)` : s);

// Firestore's typed value → plain JSON, with long strings, big arrays and maps and deep nesting cut short.
export function decodeValue(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (depth > FS_DEPTH) return "…";
  if ("nullValue" in o) return null;
  if ("booleanValue" in o) return Boolean(o.booleanValue);
  if ("integerValue" in o) {
    const n = Number(o.integerValue);
    return Number.isSafeInteger(n) ? n : String(o.integerValue);
  }
  if ("doubleValue" in o) return typeof o.doubleValue === "number" ? o.doubleValue : String(o.doubleValue);
  if ("timestampValue" in o) return String(o.timestampValue);
  if ("stringValue" in o) return clip(String(o.stringValue));
  if ("bytesValue" in o) return `bytes (${Math.floor((String(o.bytesValue).length * 3) / 4)} B)`;
  if ("referenceValue" in o) return clip(String(o.referenceValue).replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, ""));
  if ("geoPointValue" in o) return o.geoPointValue;
  if ("arrayValue" in o) {
    const list = ((o.arrayValue as { values?: unknown[] } | null)?.values ?? []);
    const out = list.slice(0, FS_ARRAY_CAP).map((x) => decodeValue(x, depth + 1));
    if (list.length > FS_ARRAY_CAP) out.push(`… ${list.length - FS_ARRAY_CAP} more`);
    return out;
  }
  if ("mapValue" in o) return decodeFields((o.mapValue as { fields?: Record<string, unknown> } | null)?.fields ?? {}, depth + 1);
  return null;
}

export function decodeFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(fields).sort();
  for (const k of keys.slice(0, FS_MAP_CAP)) out[clip(k)] = decodeValue(fields[k], depth);
  if (keys.length > FS_MAP_CAP) out["…"] = `${keys.length - FS_MAP_CAP} more fields`;
  return out;
}

export type FsDoc = { id: string; json: string };
export type FsRun = { docs: FsDoc[]; reads: number; truncated: boolean };

const runAnswer = z.array(z.looseObject({
  document: z.object({ name: z.string(), fields: z.record(z.string(), z.unknown()).optional() }).optional(),
}));

export function readRunAnswer(data: unknown): FsRun | null {
  const p = runAnswer.safeParse(data);
  if (!p.success) return null;
  const docs: FsDoc[] = [];
  let size = 0;
  let truncated = false;
  const found = p.data.filter((x) => x.document);
  for (const x of found) {
    const d = x.document!;
    const json = JSON.stringify(decodeFields(d.fields ?? {}), null, 1);
    size += json.length;
    if (size > FS_PAYLOAD_CAP) {
      truncated = true;
      break;
    }
    docs.push({ id: clip(d.name.split("/").pop() ?? d.name), json });
  }
  // Billing: one read per document returned, and a query that returns nothing still costs one.
  return { docs, reads: Math.max(1, found.length), truncated };
}

const pid = (v: string) => encodeURIComponent(v);
const base = (projectId: string) => `https://firestore.googleapis.com/v1/projects/${pid(projectId)}/databases/(default)/documents`;

export async function listRootCollections(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<{ ids: string[]; more: boolean }>> {
  const r = await callJson("Firestore", `${base(projectId)}:listCollectionIds`, { method: "POST", token, body: { pageSize: 100 } }, opts);
  if (!r.ok) return r;
  const p = z.object({ collectionIds: z.array(z.string()).optional(), nextPageToken: z.string().optional() }).safeParse(r.data ?? {});
  if (!p.success) return formatFailure("Firestore", "the collection list");
  return { ok: true, data: { ids: (p.data.collectionIds ?? []).sort(), more: Boolean(p.data.nextPageToken) } };
}

export async function runFirestoreQuery(token: string, projectId: string, body: { structuredQuery: Record<string, unknown> }, opts: FetchOpts = {}): Promise<Result<FsRun>> {
  const r = await callJson("Firestore", `${base(projectId)}:runQuery`, { method: "POST", token, body }, opts);
  if (!r.ok) return r;
  const read = readRunAnswer(r.data);
  return read ? { ok: true, data: read } : formatFailure("Firestore", "the query answer");
}
