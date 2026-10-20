import type { ChatMessage, SnapshotRec } from "@/private/assist/prompts";
import type { SnapshotApp } from "@/private/console/types";
import { isDemo } from "@/lib/mode";
import { complete, consoleTarget } from "@/private/ai/gateway";
import { appDetail, snapAdvisor } from "@/private/console/snapshot";

// The things this feature needs from other private tasks, as one interface so it can be mocked in tests.
//
//   provider(): the console's default AI provider if one is connected and usable, else null (no provider = no
//   "Answer now", no AI summary; "Ask Antigravity" stays).
//   appSnapshot(key, now): one app as scrubbed snapshot data (name or console uuid), null when unknown. = T5 appDetail.
//   advice(now): the scrubbed recommendations ({ title, app, severity }). = T5 snapAdvisor.
//   complete(messages, opts): one chat completion through the gateway. = T3 complete.
export type ProviderInfo = { name: string; model: string }; // model = the public id, e.g. "gemini/gemini-3.8-flash"
export type CompleteResult = { text: string; model: string; ms: number };
export type CompleteOptions = { model?: string; maxTokens?: number; temperature?: number; purpose: "ask-ai" | "summary" | "playground" | "console-chat" };

export type AssistPorts = {
  provider(): Promise<ProviderInfo | null>;
  appSnapshot(key: string, now: Date): Promise<SnapshotApp | null>;
  advice(now: Date): Promise<SnapshotRec[]>;
  complete(messages: ChatMessage[], opts: CompleteOptions): Promise<CompleteResult>;
};

// Wired at integration (stage 5c): Task 3's gateway helpers and Task 5's snapshot readers. appDetail resolves an app by
// console uuid or name (Task 5 resolveApp), so "Ask Antigravity" and "Answer now" find apps by the uuid the slot passes.
// provider() is null whenever consoleTarget() throws (nothing connected, or no model turned on).
export const ports: AssistPorts = {
  provider: async () => {
    if (isDemo()) return { name: "Demo", model: "demo" }; // complete() answers with the demo's canned reply
    try {
      const t = await consoleTarget();
      return { name: t.conn.name, model: t.publicId };
    } catch {
      return null;
    }
  },
  appSnapshot: appDetail,
  advice: snapAdvisor,
  complete,
};
