import { AG_PUBLIC_PREFIX } from "@/private/ai/extras";
import { isOfferedModel } from "@/private/ai/providers/routing";
import type { ExplorerModels, ModelOption } from "./live-model";

// The explorer page's model data (pure; the page reads modelRows() and the Antigravity settings). The same list
// GET /api/v1/ai/models gives an unpinned key: enabled models of enabled providers that the gateway offers, then the
// Antigravity models switched on, only while Antigravity is connected. The default is the console's default model when
// it is on, else the first provider model; never an ag/ model (those can't answer /chat/completions).

export type ModelRowLike = { publicId: string; enabled: boolean; providerEnabled: boolean; upstream: string; manual: boolean; providerKind: string };

export function explorerModels(input: { rows: ModelRowLike[]; defaultModel: string | null; ag: { connected: boolean; ids: string[] } }): ExplorerModels {
  const provider = [...new Set(input.rows
    .filter((r) => r.enabled && r.providerEnabled && isOfferedModel({ upstream: r.upstream, manual: r.manual }, r.providerKind))
    .map((r) => r.publicId))];
  const def = input.defaultModel && provider.includes(input.defaultModel) ? input.defaultModel : (provider[0] ?? null);
  const ordered = def ? [def, ...provider.filter((id) => id !== def)] : provider;
  const options: ModelOption[] = ordered.map((id) => ({ id, isDefault: id === def, async: false }));
  if (input.ag.connected) {
    for (const id of new Set(input.ag.ids)) options.push({ id: `${AG_PUBLIC_PREFIX}${id}`, isDefault: false, async: true });
  }
  return { defaultModel: def, options };
}
