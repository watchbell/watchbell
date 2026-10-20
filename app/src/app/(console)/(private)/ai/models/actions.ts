"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { SCAN_BUDGET_MS, testModels } from "@/private/ai/providers/model-test";
import { syncModelsNow } from "@/private/ai/extras";
import { runAdvisorNotes, saveAdvisorSettings } from "@/private/assist/advisor-notes";
import { modelRows, setDefaultModel } from "@/private/ai/views-db";
import { refreshProviderModels, setModelEnabled } from "@/private/ui/deps";

// R2: owner only. Model switches and the default model change console rows only.
const INVALID = "Something in that request wasn't valid.";
const audit = async (message: string, actorUserId: string) => {
  try {
    await recordAction({ kind: "ok", message, resourceId: null, actorUserId });
  } catch {
    console.warn("audit event failed");
  }
};

export async function toggleModel(providerId: string, modelId: string, on: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(providerId) || typeof modelId !== "string" || modelId.length < 1 || modelId.length > 200 || typeof on !== "boolean") return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const done = await setModelEnabled(providerId, modelId, on);
    if (!done.ok) return { ok: false, error: done.error };
    await audit(`AI model ${on ? "enabled" : "disabled"}: ${modelId}`, member.userId);
    refresh();
    return { ok: true, message: `${modelId} is ${on ? "on" : "off"}. Takes effect on the next request.` };
  }, { requireActionMember });
}

// The console's own AI (Ask AI, summaries, Playground) uses this model when none is picked. Only models the gateway offers are
// stored (Task 3 lets only Google models be switched on), so "enabled" already means Gemini/Antigravity (or Gemma on Workers AI).
export async function makeDefaultModel(publicId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (typeof publicId !== "string" || publicId.length > 240) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const { rows } = await modelRows();
    const row = rows.find((r) => r.publicId === publicId);
    if (!row || !row.enabled || !row.providerEnabled) return { ok: false, error: "Turn the model on first." };
    await setDefaultModel(publicId, new Date());
    await audit(`AI default model: ${publicId}`, member.userId);
    refresh();
    return { ok: true, message: `${publicId} is now the default model.` };
  }, { requireActionMember });
}

// "Refresh models": asks every enabled connection for its model list again (the connection test stores the result).
export async function refreshAllModels(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const quota = await limit(LIMITS.refresh, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many refreshes. Try again in ${minutesText(quota.retryAfter)}.` };
    const { providers } = await modelRows();
    const on = providers.filter((p) => p.enabled);
    if (on.length === 0) return { ok: false, error: "No provider is connected." };
    let failed = 0;
    for (const p of on) {
      try {
        const r = await refreshProviderModels(p.id);
        if (!r.ok) failed++;
      } catch {
        failed++;
      }
    }
    refresh();
    return failed === on.length
      ? { ok: false, error: "No provider answered. Check the connection under Bring your own key." }
      : { ok: true, message: failed ? `Asked ${on.length - failed} of ${on.length} providers for their model list.` : `Asked ${on.length} provider${on.length === 1 ? "" : "s"} for the model list.` };
  }, { requireActionMember });
}

// Models › Sync now (owner 16 Oct): the model sync's run now (list, diff, test new and failed models, Telegram),
// whatever the 6-hour clock says. Real provider calls, so the credential-test budget.
export async function syncModelsNowAction(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many syncs. Try again in ${minutesText(quota.retryAfter)}.` };
    const started = Date.now();
    const run = await syncModelsNow(new Date(started), started + SCAN_BUDGET_MS);
    refresh();
    if (!run) return { ok: false, error: "The sync stopped with an error. Try again." };
    if (run.conns.length === 0) return { ok: false, error: "No custom server is connected and on." };
    const failed = run.conns.find((c) => !c.ok);
    if (failed && run.conns.every((c) => !c.ok)) return { ok: false, error: `${failed.name}: ${failed.error ?? "the sync failed"}.` };
    const s = run.summary;
    const parts = [`${s.listed} listed`, s.added && `${s.added} new`, s.removed && `${s.removed} removed`, s.returned && `${s.returned} back`, `${s.tested} tested`, s.ready && `${s.ready} turned on`].filter(Boolean);
    return { ok: true, message: `Synced: ${parts.join(", ")}.${run.pending ? " Some new models wait for their test; the next run comes within minutes." : ""}` };
  }, { requireActionMember });
}

// Models › Test (one model) and Scan all (every model of one connection, four at a time, within ~50 s; the rest on the
// next Scan). Owner only, the credential-test budget (20 per 10 minutes per member): each one is real provider calls.
export type ScanResult = { tested: number; working: number; skipped: number };

async function runTests(providerId: unknown, modelId: string | null): Promise<ActionResult<ScanResult>> {
  return runGuarded("owner", async (member): Promise<ActionResult<ScanResult>> => {
    if (!isUuid(providerId) || (modelId !== null && (typeof modelId !== "string" || modelId.length < 1 || modelId.length > 200))) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many tests. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await testModels(providerId as string, modelId === null ? null : [modelId]);
    if (!r.ok) return { ok: false, error: r.error };
    refresh();
    const working = r.tested.filter((t) => t.test.ok).length;
    const data = { tested: r.tested.length, working, skipped: r.skipped };
    if (modelId !== null) {
      const t = r.tested[0]?.test;
      return t?.ok ? { ok: true, message: `${modelId} works (${(t.ms / 1000).toFixed(1)} s).`, data } : { ok: false, error: `${modelId}: ${t?.error ?? "not tested"}.` };
    }
    return { ok: true, message: `${working} of ${r.tested.length} model${r.tested.length === 1 ? "" : "s"} answered.${r.skipped ? ` ${r.skipped} not tested yet: run Scan all again.` : ""}`, data };
  }, { requireActionMember });
}

export async function testModelAction(providerId: string, modelId: string): Promise<ActionResult<ScanResult>> {
  return runTests(providerId, typeof modelId === "string" ? modelId : "");
}

export async function scanModelsAction(providerId: string): Promise<ActionResult<ScanResult>> {
  return runTests(providerId, null);
}

// Advisor notes by the provider (owner 14 Oct): on/off and the model (null = the default model), and Run now.
export async function setAdvisorNotesAction(enabled: boolean, model: string | null): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (typeof enabled !== "boolean" || (model !== null && (typeof model !== "string" || model.length < 1 || model.length > 200))) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.alertWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    if (model !== null) {
      const { rows } = await modelRows();
      if (!rows.some((r) => r.publicId === model && r.enabled && r.providerEnabled)) return { ok: false, error: "Turn the model on first." };
    }
    await saveAdvisorSettings({ enabled, model });
    await audit(`AI advisor notes ${enabled ? "on" : "off"}${model ? ` · ${model}` : ""}`, member.userId);
    refresh();
    return { ok: true, message: enabled ? `Advisor notes are on (${model ?? "default model"}), at 07:00 and 19:00 WIB.` : "Advisor notes are off." };
  }, { requireActionMember });
}

export async function runAdvisorNowAction(): Promise<ActionResult<{ count: number }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ count: number }>> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many runs. Try again in ${minutesText(quota.retryAfter)}.` };
    try {
      const r = await runAdvisorNotes(new Date(), { force: true, deadlineMs: 45_000 });
      if (r.status === "skipped") {
        const why = r.reason === "no-provider" ? "No AI provider is connected." : r.reason === "no-apps" ? "No watched app to write about." : "The model's answer had no usable note. Try again.";
        return { ok: false, error: why };
      }
      refresh();
      return { ok: true, message: `${r.count} advisor note${r.count === 1 ? "" : "s"} written by ${r.model}.`, data: { count: r.count } };
    } catch (e) {
      const msg = e instanceof Error && e.name === "GatewayError" ? e.message.slice(0, 300) : e instanceof Error && e.message === "advisor deadline" ? "The provider took too long. Try again." : "The AI provider couldn't answer. Try again.";
      return { ok: false, error: msg };
    }
  }, { requireActionMember });
}
