import { describe, expect, it } from "vitest";
import { OPENAPI_COPY } from "@/lib/copy/edition";
import { OPS, canTry, needsKey, opById } from "./operations";
import { openApiDocument } from "./spec";

const doc = openApiDocument("https://watch.example.com/");
const ops = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op: op! })));

describe("openApiDocument", () => {
  it("is OpenAPI 3.1 with this deployment as its server (no trailing slash)", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://watch.example.com", description: "This deployment" }]);
    expect(doc.info.title).toBe("Watchbell API");
  });
  it("describes the console key as an http bearer scheme", () => {
    expect(doc.components.securitySchemes.consoleKey).toMatchObject({ type: "http", scheme: "bearer" });
  });
  it("has every operation once, with a unique operationId, a tag and a response", () => {
    expect(ops).toHaveLength(OPS.length);
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { op } of ops) {
      expect(op.operationId).toMatch(/^[a-z][A-Za-z0-9]+$/);
      expect(op.tags).toHaveLength(1);
      expect(Object.keys(op.responses).length).toBeGreaterThan(0);
      expect(doc.tags.map((t) => t.name)).toContain(op.tags[0]);
    }
  });
  it("gives every non-docs operation a scope and a security requirement", () => {
    for (const { path, op } of ops.filter((o) => !o.op["x-watchbell-docs-only"])) {
      expect(typeof op["x-watchbell-scope"], path).toBe("string");
      expect(Array.isArray(op.security), path).toBe(true);
    }
  });
  it("requires the consoleKey exactly for the endpoints that need a key", () => {
    for (const op of OPS.filter((o) => !o.docsOnly)) {
      const spec = doc.paths[op.path][op.method]!;
      expect(spec.security, op.id).toEqual(needsKey(op) ? [{ consoleKey: [] }] : []);
    }
    expect(doc.paths["/api/v1/status"].get!["x-watchbell-scope"]).toBe("read:status");
    expect(doc.paths["/api/v1/ai/chat/completions"].post!["x-watchbell-scope"]).toBe("ai:invoke");
    expect(doc.paths["/api/v1/me"].get!["x-watchbell-scope"]).toBe("any");
  });
  it("marks exactly the scheduler endpoints docs-only, without a security property", () => {
    const docs = ops.filter((o) => o.op["x-watchbell-docs-only"]);
    expect(docs.map((o) => o.path).sort()).toEqual(["/api/collect", "/api/daily", "/api/watchdog"]);
    for (const { op } of docs) {
      expect(op["x-watchbell-docs-only"]).toBe(true);
      expect("security" in op).toBe(false);
    }
  });
  it("lists every /api/v1 route and the other documented endpoints", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/collect", "/api/daily", "/api/health", "/api/ping/{token}", "/api/ping/{token}/fail", "/api/ping/{token}/start", "/api/v1/advice", "/api/v1/ai/chat/completions",
      "/api/v1/ai/models", "/api/v1/ai/questions", "/api/v1/ai/questions/{id}", "/api/v1/mcp", "/api/v1/me", "/api/v1/openapi.json", "/api/v1/status", "/api/v1/status/apps/{app}", "/api/watchdog",
    ]);
  });
  it("declares every path template variable as a path parameter", () => {
    for (const { path, op } of ops) {
      const vars = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      expect(declared.sort(), path).toEqual(vars.sort());
    }
  });
  it("documents the question pair: 201 answered by the provider or 202 queued for Antigravity, then the question by id", () => {
    const ask = doc.paths["/api/v1/ai/questions"].post!;
    expect(ask["x-watchbell-scope"]).toBe("ai:invoke");
    expect(Object.keys(ask.responses).sort()).toEqual(["201", "202", "400", "401", "403", "413", "429", "502", "503"]);
    expect(JSON.stringify(ask.responses["201"])).toContain("answeredBy");
    expect(JSON.stringify(ask.responses["202"])).toContain("pollUrl");
    expect(JSON.stringify(ask.requestBody)).toContain('"maxLength":2000');
    const one = doc.paths["/api/v1/ai/questions/{id}"].get!;
    expect(Object.keys(one.responses).sort()).toEqual(["200", "401", "403", "404", "429"]);
    expect(JSON.stringify(one.responses["200"])).toContain("answeredBy");
  });
  it("documents /advice with a required app query parameter and its 404", () => {
    const op = doc.paths["/api/v1/advice"].get!;
    expect(op.parameters).toContainEqual(expect.objectContaining({ name: "app", in: "query", required: true }));
    expect(op.responses["404"]).toBeDefined();
    expect(op["x-watchbell-scope"]).toBe("read:status");
  });
  it("leaves out header parameters OpenAPI ignores (Accept)", () => {
    const names = (doc.paths["/api/v1/mcp"].post!.parameters ?? []).map((p) => p.name);
    expect(names).not.toContain("Accept");
    expect(names).toContain("MCP-Protocol-Version");
  });
  it("carries the request examples (chat body, MCP messages)", () => {
    const body = doc.paths["/api/v1/ai/chat/completions"].post!.requestBody as { content: { "application/json": { example: { model: string }; examples: Record<string, unknown> } } };
    expect(body.content["application/json"].example.model).toBe("gemini/gemini-3.8-flash");
    expect(Object.keys(body.content["application/json"].examples)).toEqual(["Hello in five words", "Streaming (SSE)", OPENAPI_COPY.advisorExample.name]);
  });
  it("stays plain JSON and contains no real-looking key", () => {
    const text = JSON.stringify(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text).not.toMatch(/w[bp]_[A-Za-z0-9]{40}/);
  });
});

describe("OPS", () => {
  it("has unique ids and every example op id resolves", () => {
    expect(new Set(OPS.map((o) => o.id)).size).toBe(OPS.length);
    for (const o of OPS) expect(opById(o.id)).toBe(o);
    expect(opById("nope")).toBeUndefined();
    expect(opById(undefined)).toBeUndefined();
  });
  it("keeps secrets out of the examples: heartbeat tokens are secret params, bodies are valid JSON", () => {
    for (const o of OPS) {
      for (const p of o.params.filter((x) => x.name === "token")) expect(p.secret).toBe(true);
      if (o.body) expect(() => JSON.parse(o.body!)).not.toThrow();
      for (const e of o.examples ?? []) if (e.body) expect(() => JSON.parse(e.body!)).not.toThrow();
      expect(Object.keys(o.examples?.flatMap((e) => Object.keys(e.headers ?? {})) ?? {})).not.toContain("authorization");
    }
  });
  it("offers Try it for everything except the three scheduler endpoints (pings take a pasted token)", () => {
    expect(OPS.filter((o) => !canTry(o)).map((o) => o.id).sort()).toEqual(["collect", "daily", "watchdog"]);
    expect(canTry(opById("ping")!)).toBe(true);
    expect(needsKey(opById("ping")!)).toBe(false);
    expect(needsKey(opById("openapi")!)).toBe(true);
  });
});
