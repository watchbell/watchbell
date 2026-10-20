import { type ApiOp, OPS, type ParamSpec, TAG_DESCRIPTION, TAGS } from "./operations";

// OpenAPI 3.1 for the console's own endpoints (R9): one hand-written document, no generator. Built from OPS (the same
// table the API explorer page renders), so docs and page can't drift. Pure.

type Json = Record<string, unknown>;
export type OpenApiOperation = {
  operationId: string; summary: string; description: string; tags: string[];
  parameters?: Json[]; requestBody?: Json; responses: Record<string, Json>;
  security?: Record<string, string[]>[];
  "x-watchbell-scope": string; "x-watchbell-docs-only"?: true;
};
export type OpenAPIV31Document = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string; license?: { name: string; identifier: string } };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Partial<Record<"get" | "post" | "head", OpenApiOperation>>>;
  components: { securitySchemes: Record<string, Json>; schemas: Record<string, Json>; responses: Record<string, Json> };
};

export const SPEC_VERSION = "1.0.0";
// OpenAPI says a header parameter named Accept, Content-Type or Authorization is ignored: these are described elsewhere.
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);

const ERROR_REF = { $ref: "#/components/schemas/Error" };
const errorResponse = (description: string, type: string): Json => ({
  description, content: { "application/json": { schema: ERROR_REF, example: { error: { type, message: description } } } },
});

const CHAT_SCHEMA: Json = {
  type: "object", required: ["model", "messages"],
  properties: {
    model: { type: "string", description: "provider/model (for example gemini/gemini-3.8-flash), or a bare id for the default provider." },
    messages: { type: "array", maxItems: 100, items: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["system", "user", "assistant", "tool"] }, content: {} } } },
    stream: { type: "boolean" }, stream_options: { type: "object" }, temperature: { type: "number" }, top_p: { type: "number" },
    max_tokens: { type: "integer" }, max_completion_tokens: { type: "integer" }, stop: {}, n: { type: "integer", const: 1 },
    presence_penalty: { type: "number" }, frequency_penalty: { type: "number" }, seed: { type: "integer" }, response_format: { type: "object" },
    tools: { type: "array" }, tool_choice: {}, user: { type: "string" },
  },
  additionalProperties: false,
};
const RPC_SCHEMA: Json = {
  type: "object", required: ["jsonrpc", "method"],
  properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "integer", "null"] }, method: { type: "string" }, params: { type: "object" } },
};
const QUESTION_SCHEMA: Json = {
  type: "object", required: ["question"],
  properties: { question: { type: "string", minLength: 1, maxLength: 2000, description: "Plain text or markdown. No keys or tokens: such text is refused." } },
};
const BODY_SCHEMAS: Record<string, Json> = { "ai-chat": CHAT_SCHEMA, mcp: RPC_SCHEMA, "ai-questions": QUESTION_SCHEMA };

// The answers every key-protected endpoint can give, and the ones particular endpoints add.
const EXTRA_STATUS: Record<string, number[]> = {
  "ai-chat": [400, 429, 502, 503], "ai-questions": [400, 413, 502, 503], "ai-question": [404], status: [400], "status-app": [404], advice: [400, 404], mcp: [400], ping: [404, 429], "ping-start": [404, 429], "ping-fail": [404, 429],
};
const STATUS_ERRORS: Record<number, [string, string]> = {
  400: ["The request was invalid.", "invalid_request"], 413: ["The request body is too large.", "invalid_request"], 404: ["Not found.", "not_found"], 429: ["Rate limit reached.", "key_rate_limit"],
  502: ["The provider failed.", "upstream_error"], 503: ["No provider is connected.", "provider_not_connected"],
};

function paramOf(p: ParamSpec): Json {
  return {
    name: p.name, in: p.in, required: p.in === "path" ? true : p.required, description: p.description,
    schema: { type: p.type }, ...(p.example !== undefined ? { example: p.example } : {}),
  };
}

function responseBody(op: Pick<ApiOp, "response">): Json {
  const r = op.response;
  if (!r) return { description: "OK." };
  const json = r.contentType.includes("json");
  let example: unknown = r.example;
  if (json) {
    try { example = JSON.parse(r.example); } catch { /* keep the text */ }
  }
  return { description: r.description, content: { [r.contentType]: { example } } };
}

function operationOf(op: ApiOp): OpenApiOperation {
  const parameters = op.params.filter((p) => !(p.in === "header" && IGNORED_HEADERS.has(p.name.toLowerCase()))).map(paramOf);
  const responses: Record<string, Json> = { [String(op.response?.status ?? 200)]: responseBody(op) };
  for (const r of op.alsoResponses ?? []) responses[String(r.status)] = responseBody({ response: r });
  if (op.access === "key" || op.access === "keyOrOwner") {
    responses["401"] = { $ref: "#/components/responses/InvalidKey" };
    if (op.scope && op.scope !== "any") responses["403"] = { $ref: "#/components/responses/MissingScope" };
    responses["429"] = { $ref: "#/components/responses/RateLimited" };
  }
  for (const code of EXTRA_STATUS[op.id] ?? []) {
    const [message, type] = STATUS_ERRORS[code];
    responses[String(code)] ??= errorResponse(message, type);
  }
  const out: OpenApiOperation = {
    operationId: op.operationId, summary: op.summary, description: op.description, tags: [op.tag],
    ...(parameters.length ? { parameters } : {}), responses, "x-watchbell-scope": op.scope ?? op.scopeLabel,
  };
  if (op.body) {
    const content: Json = { schema: BODY_SCHEMAS[op.id] ?? { type: "object" } };
    let example: unknown = op.body;
    try { example = JSON.parse(op.body); } catch { /* keep the text */ }
    content.example = example;
    const named = (op.examples ?? []).filter((e) => e.body);
    if (named.length) {
      content.examples = Object.fromEntries(named.map((e) => {
        let value: unknown = e.body;
        try { value = JSON.parse(e.body!); } catch { /* keep the text */ }
        return [e.name, { summary: e.name, value }];
      }));
    }
    out.requestBody = { required: true, description: op.bodyDescription, content: { "application/json": content } };
  }
  if (op.docsOnly) {
    out["x-watchbell-docs-only"] = true;
  } else {
    out.security = op.access === "key" || op.access === "keyOrOwner" ? [{ consoleKey: [] }] : [];
  }
  return out;
}

export function openApiDocument(origin: string): OpenAPIV31Document {
  const paths: OpenAPIV31Document["paths"] = {};
  for (const op of OPS) (paths[op.path] ??= {})[op.method] = operationOf(op);
  return {
    openapi: "3.1.0",
    info: {
      title: "Watchbell API", version: SPEC_VERSION,
      description: "Read-only console data, an OpenAI-compatible AI gateway and an MCP server for agents, plus the endpoints the schedulers and your jobs call. Create a key under AI Gateway › API keys and send it as Authorization: Bearer wb_… . Prompts and completions are never stored; the data returned is scrubbed (database aliases, no URLs, emails or secrets).",
    },
    servers: [{ url: origin.replace(/\/+$/, ""), description: "This deployment" }],
    tags: TAGS.map((name) => ({ name, description: TAG_DESCRIPTION[name] })),
    paths,
    components: {
      securitySchemes: {
        consoleKey: { type: "http", scheme: "bearer", bearerFormat: "wb_ followed by 40 letters and digits (keys made before the Watchbell rename start with wp_)", description: "A console API key. Its scopes decide which endpoints it may call (see x-watchbell-scope)." },
      },
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["type", "message"], properties: { type: { type: "string" }, message: { type: "string" } } } } },
      },
      responses: {
        InvalidKey: errorResponse("Missing, unknown, revoked or expired key.", "invalid_api_key"),
        MissingScope: errorResponse("The key lacks the scope this endpoint needs.", "missing_scope"),
        RateLimited: { ...errorResponse("The key's per-minute limit was reached.", "key_rate_limit"), headers: { "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } } } },
      },
    },
  };
}
