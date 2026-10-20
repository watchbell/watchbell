import type { ApiOp } from "@/private/openapi/operations";

// The owner's live models in the API explorer (owner 14 Oct). Pure and client-safe: the page (server) reads the enabled
// models and the console default (page-models.ts) and hands them over as props; this rewrites the "model" field of the
// bodies the explorer shows, so a sent example uses a model that is on. The static OpenAPI JSON keeps its generic example.

export type ModelOption = { id: string; isDefault: boolean; async: boolean };
export type ExplorerModels = { defaultModel: string | null; options: ModelOption[] };
export const NO_MODELS: ExplorerModels = { defaultModel: null, options: [] };

// Antigravity's ag/<id> models answer through the inbox only (POST /api/v1/ai/questions), never /chat/completions.
const ASYNC_PATHS = new Set(["/api/v1/ai/questions"]);

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const hasModel = (body: string | undefined): boolean => {
  const o = body ? parseObject(body) : null;
  return !!o && Object.hasOwn(o, "model");
};

// The body with its "model" replaced, formatted like it came (several lines → two-space indent, one line → compact).
function replaceModel(o: Record<string, unknown>, model: string, multiline: boolean): string {
  const next = Object.hasOwn(o, "model") ? { ...o, model } : { model, ...o };
  return multiline ? JSON.stringify(next, null, 2) : JSON.stringify(next);
}

const withModel = (body: string | undefined, model: string): string | undefined => {
  if (body === undefined || !hasModel(body)) return body;
  return replaceModel(parseObject(body)!, model, body.includes("\n"));
};

// The operation with the live model in its default body and named examples (a copy; OPS itself is never changed).
export function liveOp(op: ApiOp, model: string | null): ApiOp {
  if (!model || !opTakesModel(op)) return op;
  return { ...op, body: withModel(op.body, model), examples: op.examples?.map((e) => ({ ...e, body: withModel(e.body, model) })) };
}

// Whether the operation's body carries a model: its default body or one of its examples has the field.
export const opTakesModel = (op: ApiOp): boolean => op.body !== undefined && (hasModel(op.body) || (op.examples ?? []).some((e) => hasModel(e.body)));

export const modelOptionsFor = (op: ApiOp, models: ExplorerModels): ModelOption[] =>
  ASYNC_PATHS.has(op.path) ? models.options : models.options.filter((m) => !m.async);

// The model the body names now, when it is a JSON object with a string model.
export function bodyModel(body: string): string | null {
  const o = parseObject(body);
  return o && typeof o.model === "string" ? o.model : null;
}

// Choosing a model in the Model list: rewrite (or add) the field. A body that isn't a JSON object is left as typed.
export function setBodyModel(body: string, model: string): { ok: true; body: string } | { ok: false; error: string } {
  const o = parseObject(body.trim());
  if (!o) return { ok: false, error: "The body isn't valid JSON, so the model can't be set. Fix the JSON or edit the model by hand." };
  return { ok: true, body: replaceModel(o, model, body.trim().includes("\n")) };
}

// The gateway's 400 for a model that is switched off or unknown: { error: { type: "model_not_enabled", … } }.
export function isModelNotEnabled(r: { status: number; body: string }): boolean {
  if (r.status !== 400) return false;
  const o = parseObject(r.body);
  const err = o?.error;
  return typeof err === "object" && err !== null && (err as Record<string, unknown>).type === "model_not_enabled";
}
