// What the AI section's provider banner and Bring your own key's info box say (owner 13 Oct 18:05). Pure, so the
// client banner and the server page share it and the states are tested without rendering.
// `antigravityModels`: enabled Antigravity models when the VM reported within 24 h, else null (not connected).

import { BANNER_COPY } from "@/lib/copy/edition";

export type AiBannerState =
  | { kind: "provider"; title: string; body: string; link: { href: string; text: string } }
  | { kind: "antigravity"; title: string; body: string; link: { href: string; text: string } }
  | { kind: "none"; title: string; body: string; action: { href: string; text: string } }
  | null;

const PROVIDERS = "/ai/providers";

// `provider` (owner 14 Oct): the default provider and model the console's AI answers with, when one is connected.
export function aiBanner({ show, antigravityModels, pathname, provider = null }: { show: boolean; antigravityModels: number | null; pathname: string; provider?: { name: string; model: string } | null }): AiBannerState {
  // Bring your own key is where a provider is connected, so the banner steps aside there (it has its own box).
  if (pathname.startsWith(PROVIDERS)) return null;
  if (!show) {
    if (!provider) return null;
    return {
      kind: "provider",
      title: `Answers come from your provider ${provider.name} (${provider.model}).`,
      body: "Ask, the Why dialog, advisor notes and POST /api/v1/ai/questions answer through it.",
      link: { href: "/ai/models", text: "Change the default model →" },
    };
  }
  if (antigravityModels !== null) {
    return {
      kind: "antigravity",
      title: BANNER_COPY.agentTitle(antigravityModels),
      body: BANNER_COPY.agentBody,
      link: { href: PROVIDERS, text: "Real-time provider (optional) →" },
    };
  }
  return {
    kind: "none",
    title: "No AI provider is connected",
    body: BANNER_COPY.noneBody,
    action: { href: PROVIDERS, text: "Connect a provider" },
  };
}

// Bring your own key's info box while no provider is on. `agFresh`: Antigravity reported within 24 h.
export function providersInfo(agFresh: boolean): { title: string; body: string } {
  if (agFresh) {
    return {
      title: BANNER_COPY.infoAgentTitle,
      body: BANNER_COPY.infoAgentBody,
    };
  }
  return {
    title: "No provider connected",
    body: BANNER_COPY.infoBody,
  };
}
