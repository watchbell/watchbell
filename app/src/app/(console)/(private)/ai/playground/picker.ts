import { AG_PUBLIC_PREFIX, type AgModel } from "@/private/ai/extras";
import type { PickerOption } from "./fold";

// The Playground's model picker (owner 13 Oct 18:05), built by the page (server side: the Antigravity part comes
// through ai/extras, which the open source edition leaves empty).

// Provider models (real-time, streaming as before) first, then the Antigravity models the owner switched on, as ag/<id>.
export function pickerOptions(providerIds: string[], agModels: AgModel[]): PickerOption[] {
  return [
    ...providerIds.map((id): PickerOption => ({ id, label: id, via: "provider" })),
    ...agModels.map((m): PickerOption => {
      const id = `${AG_PUBLIC_PREFIX}${m.id}`;
      return { id, label: m.label && m.label !== m.id ? `${id} · ${m.label}` : id, via: "antigravity" };
    }),
  ];
}

// Real-time first: the provider default, else the first provider model; without providers the Antigravity default,
// else the first Antigravity model.
export function initialModel(options: PickerOption[], providerDefault: string | null, agDefault: string | null): string {
  const has = (id: string | null) => !!id && options.some((o) => o.id === id);
  if (has(providerDefault)) return providerDefault as string;
  const firstProvider = options.find((o) => o.via === "provider");
  if (firstProvider) return firstProvider.id;
  const agDef = agDefault ? `${AG_PUBLIC_PREFIX}${agDefault}` : null;
  if (has(agDef)) return agDef as string;
  return options[0]?.id ?? "";
}
