// Which way an Ask question goes (owner 14 Oct: the provider first). Pure, no imports, so tests and the REST route share it.

export type AskContext = {
  agConnected: boolean; // Antigravity reported within 24 h (isFresh)
  agEnabled: readonly string[]; // Antigravity models the owner switched on
  providerReady: boolean; // a provider connection with a usable default model
};
export type AskPath =
  | { via: "provider"; model?: string }
  | { via: "antigravity"; model: string | null }
  | { via: "none"; error: string };

export const NO_PROVIDER = "No AI provider is connected. Connect one under AI Gateway › Bring your own key.";
export const MODEL_UNAVAILABLE = "That model isn't available. Pick another one or Default.";

// Default → the provider (Antigravity only when no provider is ready but the VM is connected). "ag/<id>" (or a bare
// Antigravity id) → the inbox, only while Antigravity is connected and that model is on. Anything else is a provider
// model id ("test/prrojects"); the gateway checks it is enabled.
export function chooseAskPath(model: string | null | undefined, ctx: AskContext): AskPath {
  const m = typeof model === "string" ? model.trim() : "";
  if (!m) {
    if (ctx.providerReady) return { via: "provider" };
    if (ctx.agConnected) return { via: "antigravity", model: null };
    return { via: "none", error: NO_PROVIDER };
  }
  if (m.length > 200) return { via: "none", error: MODEL_UNAVAILABLE };
  if (m.startsWith("ag/")) {
    const id = m.slice(3);
    return ctx.agConnected && ctx.agEnabled.includes(id) ? { via: "antigravity", model: id } : { via: "none", error: MODEL_UNAVAILABLE };
  }
  if (ctx.agConnected && ctx.agEnabled.includes(m)) return { via: "antigravity", model: m };
  return { via: "provider", model: m };
}

