import "server-only";
import type { ActionResult } from "@/lib/action";
import { complete } from "@/private/ai/gateway";
import { quotaRows, setLimits as setProviderLimits, setModelEnabled as setProviderModelEnabled, testConnection } from "@/private/ai/providers/providers-db";
import type { QuotaGroup } from "@/private/ai/quota";
import { consoleSnapshot } from "@/private/console/snapshot";
import type { ChatTurn, CompleteOptions, Completion, OwnLimitInput } from "./deps-types";

// The ONE file where Task 4 touches what Tasks 3 and 5 produce (their modules arrive with the merge). Everything else in
// the AI Gateway pages goes through here, so a signature that differs at merge is fixed in this file and its test mock.

export type { QuotaGroup };

// T3 providers-db: the quota groups for the Antigravity-style Quota page (stored observations + the owner's limits).
export const groupedQuota = (now: Date): Promise<QuotaGroup[]> => quotaRows(now);

// T3 providers-db writers answer with an ActionResult (ok / error) and do their own validation.
export const setModelEnabled = (providerId: string, modelId: string, on: boolean): Promise<ActionResult> => setProviderModelEnabled(providerId, modelId, on);
export const setLimits = (providerId: string, limits: OwnLimitInput[]): Promise<ActionResult> => setProviderLimits(providerId, limits);
// "Refresh models": T3's connection test asks the provider for its model list again and stores it.
export const refreshProviderModels = (providerId: string): Promise<ActionResult> => testConnection(providerId);

// T3 gateway: the console's own call (no key, nothing stored). Its errors are GatewayError with a sanitized message.
export function runComplete(messages: ChatTurn[], opts: CompleteOptions): Promise<Completion> {
  return complete(messages, opts);
}

// T5 snapshot: the scrubbed console data for the Playground's console mode (R5).
export async function snapshotJson(now: Date): Promise<string> {
  return JSON.stringify(await consoleSnapshot(now));
}
