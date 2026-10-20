import { describe, expect, it } from "vitest";
import { opById } from "@/private/openapi/operations";
import { initialBuilder } from "./request";
import { snippetsFor } from "./snippets";
import { isModelNotEnabled, liveOp, modelOptionsFor, opTakesModel, setBodyModel, type ExplorerModels } from "./live-model";

const LIVE = "test/combo-new";
const models: ExplorerModels = {
  defaultModel: LIVE,
  options: [
    { id: LIVE, isDefault: true, async: false },
    { id: "test/prrojects", isDefault: false, async: false },
    { id: "ag/gemini-3.8-flash-high", isDefault: false, async: true },
  ],
};

describe("liveOp", () => {
  it("puts the live default model in the default body and every named example", () => {
    const op = liveOp(opById("ai-chat")!, LIVE);
    expect(JSON.parse(op.body!).model).toBe(LIVE);
    expect(op.examples!.length).toBeGreaterThan(1);
    for (const e of op.examples!) expect(JSON.parse(e.body!).model, e.name).toBe(LIVE);
    expect(op.body).not.toContain("gemini/gemini-3.8-flash");
    // the rest of the body is untouched and still pretty-printed
    expect(JSON.parse(op.body!).messages).toEqual(JSON.parse(opById("ai-chat")!.body!).messages);
    expect(op.body).toContain('\n  "messages"');
  });
  it("leaves the static operation alone (the OpenAPI JSON keeps its generic example)", () => {
    liveOp(opById("ai-chat")!, LIVE);
    expect(JSON.parse(opById("ai-chat")!.body!).model).toBe("gemini/gemini-3.8-flash");
  });
  it("leaves bodies without a model field, and everything when there is no live model", () => {
    const q = opById("ai-questions")!;
    expect(liveOp(q, LIVE).body).toBe(q.body);
    const mcp = opById("mcp")!;
    expect(liveOp(mcp, LIVE).examples).toEqual(mcp.examples);
    const chat = opById("ai-chat")!;
    expect(liveOp(chat, null)).toBe(chat);
  });
  it("carries the live model into the curl, PowerShell and JavaScript snippets", () => {
    const op = liveOp(opById("ai-chat")!, LIVE);
    const b = initialBuilder(op);
    const [curl, ps, js] = snippetsFor(op, "https://watch.example.com", b);
    expect(curl.code).toContain(`"model":"${LIVE}"`);
    expect(ps.code).toContain(`\\"model\\":\\"${LIVE}\\"`);
    expect(js.code).toContain(`"model": "${LIVE}"`);
    for (const s of [curl, ps, js]) expect(s.code, s.label).not.toContain("gemini-3.8-flash");
  });
});

describe("opTakesModel", () => {
  it("is true only where a body has a model field", () => {
    expect(opTakesModel(opById("ai-chat")!)).toBe(true);
    for (const id of ["ai-questions", "mcp", "status", "health"]) expect(opTakesModel(opById(id)!), id).toBe(false);
  });
});

describe("modelOptionsFor", () => {
  it("keeps Antigravity models off the chat endpoint (they answer through /ai/questions only)", () => {
    expect(modelOptionsFor(opById("ai-chat")!, models).map((m) => m.id)).toEqual([LIVE, "test/prrojects"]);
    expect(modelOptionsFor(opById("ai-questions")!, models).map((m) => m.id)).toEqual([LIVE, "test/prrojects", "ag/gemini-3.8-flash-high"]);
  });
});

describe("setBodyModel", () => {
  it("rewrites the model field of valid JSON and keeps the other fields and their order", () => {
    const body = JSON.stringify({ model: "gemini/gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], stream: false }, null, 2);
    const r = setBodyModel(body, "test/prrojects");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.body)).toEqual({ model: "test/prrojects", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(Object.keys(JSON.parse(r.body))).toEqual(["model", "messages", "stream"]);
    expect(r.body).toContain("\n  ");
  });
  it("keeps a one-line body on one line", () => {
    const r = setBodyModel('{"messages":[],"model":"a/b"}', "test/combo-new");
    expect(r).toEqual({ ok: true, body: '{"messages":[],"model":"test/combo-new"}' });
  });
  it("adds the field (first) when the body has none", () => {
    const r = setBodyModel('{\n  "messages": []\n}', LIVE);
    expect(r.ok && Object.keys(JSON.parse(r.body))).toEqual(["model", "messages"]);
    expect(r.ok && JSON.parse(r.body).model).toBe(LIVE);
  });
  it("refuses invalid JSON (and non-objects) with a short hint and no new text", () => {
    const bad = setBodyModel('{"model": "a/b", ', LIVE);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/valid JSON/);
    expect(setBodyModel("[1,2]", LIVE).ok).toBe(false);
    expect(setBodyModel("", LIVE).ok).toBe(false);
  });
});

describe("isModelNotEnabled", () => {
  const body = JSON.stringify({ error: { type: "model_not_enabled", message: "Model \"x\" isn't enabled." } });
  it("spots the gateway's 400 model_not_enabled", () => {
    expect(isModelNotEnabled({ status: 400, body })).toBe(true);
  });
  it("ignores other statuses, other errors and bodies that aren't JSON", () => {
    expect(isModelNotEnabled({ status: 503, body })).toBe(false);
    expect(isModelNotEnabled({ status: 400, body: JSON.stringify({ error: { type: "invalid_request" } }) })).toBe(false);
    expect(isModelNotEnabled({ status: 400, body: "model_not_enabled" })).toBe(false);
  });
});
