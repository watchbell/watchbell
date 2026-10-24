import { AI_COPY } from "@/lib/copy/edition";
import type { Extension, PaletteEntry } from "@/lib/extensions";

// The private feature's registration blocks that both editions share (open source plan 5): the open source edition's
// registry.ts merges these alone; the private edition's adds its own private-only blocks. Nothing here may import a
// private-only module (the private edition's registry test walks the imports).
// Registry protocol (parallel-safe): each task edits ONLY the lines inside its own block below: its imports first,
// then its partial (`export const tN: Part = { … }`). Blocks are line-disjoint, so merges don't conflict.

export type Part = Partial<Extension>;

// `entry` right after the palette entry for `href` (at the end when there is none).
export const insertAfter = (list: PaletteEntry[], href: string, entry: PaletteEntry): PaletteEntry[] => {
  const i = list.findIndex((p) => p.href === href);
  return i < 0 ? [...list, entry] : [...list.slice(0, i + 1), entry, ...list.slice(i + 1)];
};

// Concatenates nav groups (same section and anchor → items appended), palette entries, steps and Settings tabs; a later slot
// (or runner) wins.
export function mergeExtensions(...parts: Part[]): Extension {
  const out: Extension = { nav: [], palette: [] };
  for (const p of parts) {
    for (const g of p.nav ?? []) {
      const same = out.nav.find((x) => x.section === g.section && x.after === g.after);
      if (same) same.items = [...same.items, ...g.items];
      else out.nav.push({ ...g, items: [...g.items] });
    }
    out.palette.push(...(p.palette ?? []));
    if (p.dailySteps?.length) out.dailySteps = [...(out.dailySteps ?? []), ...p.dailySteps];
    if (p.minuteSteps?.length) out.minuteSteps = [...(out.minuteSteps ?? []), ...p.minuteSteps];
    if (p.WhyAiSlot) out.WhyAiSlot = p.WhyAiSlot;
    if (p.RecSummarySlot) out.RecSummarySlot = p.RecSummarySlot;
    if (p.AiNotesSlot) out.AiNotesSlot = p.AiNotesSlot;
    if (p.DevNotesSlot) out.DevNotesSlot = p.DevNotesSlot;
    if (p.office) out.office = p.office;
    if (p.settingsTabs?.length) out.settingsTabs = [...(out.settingsTabs ?? []), ...p.settingsTabs];
    if (p.telegramCallback) out.telegramCallback = p.telegramCallback;
    if (p.runner) out.runner = p.runner;
    if (p.RepoPreviewSlot) out.RepoPreviewSlot = p.RepoPreviewSlot;
  }
  return out;
}

// ---- T1 foundation ----
// Watchbell 1.2: Manage, right after Settings (AI Gateway ti-route-2, API explorer ti-api); palette = every mockup sub-page
// both editions have (each edition adds its own entry for /ai/ask: registry.public.ts and registry-blocks-private.ts).
export const base: Part = {
  nav: [{ section: "manage", after: "settings", items: [
    { key: "ai", label: "AI Gateway", href: "/ai", icon: "route", stage: 5, ownerOnly: true },
    { key: "api-docs", label: "API explorer", href: "/api-docs", icon: "api", stage: 5, ownerOnly: true },
  ] }],
  palette: [
    { label: "AI Gateway", href: "/ai", keywords: ["ai", "gateway", "overview"] },
    { label: "API keys", href: "/ai/keys", keywords: ["key", "token", "wb_", "wp_"] },
    { label: "Agents", href: "/ai/agents", keywords: ["agent", "client", "mcp"] },
    { label: "Connect an agent", href: "/ai/connect", keywords: ["mcp", ...AI_COPY.palette.connectKeywords, "gemini cli", "quick start"] },
    { label: "Bring your own key", href: "/ai/providers", keywords: ["provider", "byok", "cloudflare", "groq", "openrouter", "gemini"] },
    { label: "Quota", href: "/ai/quota", keywords: ["limit", "usage", "rate"] },
    { label: "AI logs", href: "/ai/logs", keywords: ["logs", "requests", "usage"] },
    { label: "Models", href: "/ai/models", keywords: ["model", "llm"] },
    { label: "Playground", href: "/ai/playground", keywords: ["chat", "try", "prompt"] },
    { label: "API explorer", href: "/api-docs", keywords: ["openapi", "swagger", "api", "v1"] },
  ],
};
// ---- end T1 ----

// ---- T2 keys/agents ----
import { pruneAgents } from "@/private/agents/agents-db";
// R7: the Agents list is capped at 2,000 rows; the daily job drops the ones seen longest ago.
export const t2: Part = { dailySteps: [{ name: "ai-agents-prune", run: () => pruneAgents() }] };
// ---- end T2 ----

// ---- T3 providers ----
import { pruneUsage } from "@/private/ai/usage";
// R7: ai_usage kept 30 days; ai_agents capped at 2,000 rows (idle ones go first).
export const t3: Part = { dailySteps: [{ name: "ai-usage-retention", run: pruneUsage }] };
// ---- end T3 ----

// ---- T4 gateway pages ----
export const t4: Part = {};
// ---- end T4 ----

// ---- T5 explorer ----
export const t5: Part = {};
// ---- end T5 ----

// ---- T6 assist ----
import { advisorMinuteStep } from "./assist/advisor-notes";
import { advisorSummaryStep } from "./assist/daily";
import { AiNotesSlot } from "./slots/ai-notes-slot";
import { RecSummarySlot } from "./slots/rec-summary-slot";
import { WhyAiSlot } from "./slots/why-ai-slot";
export const t6: Part = {
  WhyAiSlot, RecSummarySlot, AiNotesSlot,
  dailySteps: [{ name: "advisor-summary", run: advisorSummaryStep }],
  // Owner 14 Oct: advisor notes by the provider at 07:00 and 19:00 WIB (replaces an agent's cron job).
  minuteSteps: [{ name: "advisor-notes", run: advisorMinuteStep }],
};
// ---- end T6 ----

// ---- T7 mcp ----
import { pruneAiNotes } from "@/private/mcp/notes-db";
// The only retention step for the AI inbox: notes 30 days and newest 200, questions 7 days (R8, owner ruling 07:30).
export const t7: Part = { dailySteps: [{ name: "ai-notes-retention", run: pruneAiNotes }] };
// ---- end T7 ----

// ---- T9 auto-actions (the shared part; the private t9 in registry-blocks-private.ts adds its own hook) ----
import { OfficeAutoRunTab } from "@/private/actions/auto-run-tab";
import { depPrMinuteStep } from "@/private/actions/dep-pr-watch-db";
import { proposalsMinuteStep, pruneProposals } from "@/private/actions/proposals-db";
// Stage 9 slice 1 (owner 15 Oct): console actions proposed for firing alerts; the owner approves on /auto-actions or
// on Telegram. Settings › Auto-actions picks which safe kinds run without asking (all off by default). Watchbell 1.2: the
// page sits in Manage right after Alerts (spec §5: Alerts and Auto-actions are Manage pages; lib/nav.ts navGroups puts
// extension items into their section).
export const t9public: Part = {
  nav: [{ section: "manage", after: "alerts", items: [
    { key: "auto-actions", label: "Auto-actions", href: "/auto-actions", icon: "bolt", stage: 9, ownerOnly: true },
  ] }],
  palette: [{ label: "Auto-actions", href: "/auto-actions", keywords: ["proposal", "approve", "reject", "auto-run", "rollback"] }],
  dailySteps: [{ name: "auto-actions-retention", run: pruneProposals }],
  // Automatic security fixes (owner 16 Oct): the merge watcher of Watchbell update PRs, every 2 minutes, right after.
  minuteSteps: [{ name: "auto-actions", run: proposalsMinuteStep }, { name: "deps-pr-watch", run: depPrMinuteStep }],
  settingsTabs: [{ key: "office-auto-run", label: "Auto-actions", Tab: OfficeAutoRunTab }],
};
// ---- end T9 ----

// ---- S7 telegram approvals ----
import { proposalCallback } from "@/private/actions/telegram-approvals";
// Stage 9 slice 7: approve / reject a proposal from its Telegram notice (inline buttons, the core webhook checks the
// chat and the owner first).
export const s7: Part = { telegramCallback: proposalCallback };
// ---- end S7 ----
