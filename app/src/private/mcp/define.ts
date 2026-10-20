import { z } from "zod";
import type { ApiKeyContext, Scope } from "@/private/auth/api-key";

// How an MCP tool is defined (moved out of tools.ts in open source plan 5, so the private edition's extra tools in
// src/private/ai can be defined without importing tools.ts, which lists them). Each tool: a JSON Schema for
// tools/list (derived from its Zod schema, so they can't drift), the scope a key needs, and a handler. Bad arguments
// → a tool execution error (`isError: true`) the model can fix.

export type ToolCtx = { key: ApiKeyContext; now: Date };
export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

type Def<S extends z.ZodType> = {
  name: string; title: string; description: string; scope: Scope; readOnly: boolean;
  args: S; run: (args: z.infer<S>, ctx: ToolCtx) => Promise<ToolResult>;
};
export type Tool = {
  name: string; title: string; description: string; scope: Scope; readOnly: boolean;
  inputSchema: Record<string, unknown>;
  call: (raw: unknown, ctx: ToolCtx) => Promise<ToolResult>;
};

export function ok(structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// The first validation issue as one readable sentence (no input echoed back).
function issueText(e: z.ZodError): string {
  const i = e.issues.find((x) => x.code === "unrecognized_keys") ?? e.issues[0];
  if (!i) return "Invalid arguments.";
  if (i.code === "unrecognized_keys") return `Unknown argument: ${i.keys.map((k) => k.slice(0, 40)).join(", ")}.`;
  const at = i.path.length ? `${i.path.join(".")}: ` : "";
  return `Invalid arguments: ${at}${i.message}`;
}

// `source` is tolerated and ignored on the write tools: the note's source is always the detected client (R8).
const IGNORED_ARGS: Record<string, string[]> = { submit_ai_note: ["source"], answer_question: ["source"] };

export function define<S extends z.ZodType>(d: Def<S>): Tool {
  const schema = z.toJSONSchema(d.args) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: d.name, title: d.title, description: d.description, scope: d.scope, readOnly: d.readOnly, inputSchema: schema,
    call: async (raw, ctx) => {
      const input = raw === undefined || raw === null ? {} : raw;
      const cleaned = input && typeof input === "object" && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input).filter(([k]) => !(IGNORED_ARGS[d.name] ?? []).includes(k)))
        : input;
      const parsed = d.args.safeParse(cleaned);
      if (!parsed.success) return fail(issueText(parsed.error));
      return d.run(parsed.data, ctx);
    },
  };
}

// A model id as the agent reports it (report_models, report_usage, report_activity).
export const agId = z.string().min(1).max(80).regex(/^[a-z0-9@/._-]+$/, { message: "use lowercase letters, digits and @ / . _ -" });
