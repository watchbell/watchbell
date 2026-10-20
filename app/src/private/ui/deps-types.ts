// Types shared between the AI Gateway pages and the one file that talks to Tasks 2, 3 and 5 (deps.ts). Pure, so client
// components and tests can import them without pulling server-only modules.
export type OwnLimitInput = { metric: string; scope: string; limit: number; window: "minute" | "day" | "week" };
export type ChatRole = "system" | "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };
export type CompleteOptions = { model?: string; maxTokens?: number; temperature?: number; purpose: "playground" };
export type Completion = { text: string; model: string; usage: { in: number | null; out: number | null }; ms: number };
