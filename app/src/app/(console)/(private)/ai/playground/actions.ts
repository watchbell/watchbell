"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { modelRows } from "@/private/ai/views-db";
import { runComplete, snapshotJson } from "@/private/ui/deps";
import type { ChatTurn } from "@/private/ui/deps-types";
import { LIMITS } from "@/private/ui/limits";
import { DEFAULT_SYSTEM, parsePlayground, safeMessage } from "./input";

export type PlaygroundReply = { text: string; model: string; tokensIn: number | null; tokensOut: number | null; ms: number; grounded: boolean };

// R2/R5: owner only; the conversation lives in the browser and is sent whole each time, nothing is stored here. Console
// mode puts the scrubbed console snapshot (aliased names, no URLs/emails/IPs/tokens) in front as a system message.
// 30 messages per owner per 10 minutes (LIMITS.playground, this task's own entry).
export async function playgroundSend(raw: unknown): Promise<ActionResult<PlaygroundReply>> {
  return runGuarded("owner", async (member): Promise<ActionResult<PlaygroundReply>> => {
    const parsed = parsePlayground(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const p = parsed.value;
    const quota = await limit(LIMITS.playground, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many messages. Try again in ${minutesText(quota.retryAfter)}.` };

    const { rows, defaultModel } = await modelRows();
    // Enabled means a model the gateway offers (Task 3 lets only Google models be switched on).
    const usable = rows.filter((m) => m.enabled && m.providerEnabled);
    if (usable.length === 0) return { ok: false, error: "No model is on. Connect a provider and turn a model on first." };
    const pick = p.model || (usable.some((m) => m.publicId === defaultModel) ? defaultModel : null) || usable[0].publicId;
    if (!usable.some((m) => m.publicId === pick)) return { ok: false, error: "That model isn't on. Pick another." };

    const system: ChatTurn[] = [{ role: "system", content: p.system.trim() || DEFAULT_SYSTEM }];
    if (p.mode === "console") system.push({ role: "system", content: `Console data (JSON, names aliased):\n${await snapshotJson(new Date())}` });
    try {
      const r = await runComplete([...system, ...p.messages], { model: pick, maxTokens: p.maxTokens, temperature: p.temperature, purpose: "playground" });
      return { ok: true, data: { text: r.text, model: r.model, tokensIn: r.usage.in, tokensOut: r.usage.out, ms: r.ms, grounded: p.mode === "console" } };
    } catch (e) {
      console.warn("playground call failed:", e instanceof Error ? e.name : "unknown");
      return { ok: false, error: safeMessage(e, "The provider didn't answer. Check the connection under Bring your own key.") };
    }
  }, { requireActionMember });
}
