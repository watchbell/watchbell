import type { Tool } from "@/private/mcp/define";
import { readSyncState, type SyncRun, type SyncState } from "./providers/model-sync";
import { AI_ALLOWED_MODELS_DEFAULT } from "./types";

// The open source edition's AI extras (exported as extras.ts): the same names as the private edition's, with nothing
// behind them. No agent reports models, so no `ag/` model is ever listed or enabled; there is no router quota and no
// model sync; no extra MCP tools.

// The public id prefix of an agent-reported model ("ag/<id>"); kept so the questions API formats ids the same way.
export const AG_PUBLIC_PREFIX = "ag/";
// A model test question and how long it may wait (the questions inbox still knows the purpose).
export const PING_TIMEOUT_MS = 10 * 60_000;
export const PING_QUESTION = "ping";

export type AgModel = { id: string; label: string };
export type AgLimit = { model: string; until: string | null; message: string };
export type AgReport = { models: AgModel[]; limits: AgLimit[]; reportedAt: string; client: string | null; keyId?: string | null };
export type AgPrefs = { disabled: string[]; defaultModel: string | null };
export type AgSettings = { report: AgReport | null; prefs: AgPrefs; allowed: readonly string[] };

// Function types spelled out so callers type-check exactly as against the private edition's functions.
export const enabledModels: (report: AgReport | null, prefs: AgPrefs, allowed: readonly string[]) => string[] = () => [];
export const effectiveDefault: (report: AgReport | null, prefs: AgPrefs, allowed: readonly string[]) => string | null = () => null;
export const isFresh: (report: AgReport | null, now: Date) => boolean = () => false;

export const readAgSettings: (now?: Date) => Promise<AgSettings> = async () => ({
  report: null, prefs: { disabled: [], defaultModel: null }, allowed: AI_ALLOWED_MODELS_DEFAULT,
});

export const readRouterQuota = async (): Promise<null> => null;

export const readModelSyncState = async (): Promise<SyncState> => readSyncState(null);

// A no-op run: no connection synced.
export const syncModelsNow: (now: Date, deadline: number) => Promise<SyncRun | null> = async () => ({
  conns: [], summary: { listed: 0, added: 0, removed: 0, returned: 0, tested: 0, ready: 0 }, pending: false,
});

export type AiExtrasFlags = { modelSync: boolean };
export const AI_EXTRAS: AiExtrasFlags = { modelSync: false };

export const extraMcpTools: Tool[] = [];
