// Stage 6 A7: one line under a connection's Access cell saying whether the console's actions work with its credential.
// Evidence first: the last write attempt (ops.settings "access.<accountId>", written by the action runner). Before any
// try, a Supabase token whose connect-time scope note says read-only is already off; nothing else is probed (A6).
export type AccessHint = { tone: "ok" | "off" | "faint"; text: string };

const ACTIONS: Record<string, { on: string; replace: string }> = {
  vercel: { on: "redeploy, roll back, promote, cancel", replace: "a token whose scope includes the team" },
  supabase: { on: "pause, restore, keep active", replace: "a token that has Project admin write" },
  neon: { on: "wake", replace: "a personal or organization key, or a key for this project" },
  // Slice 2: the Owner's DNS record edits (the read-only token connected so far answers 403 on the first try).
  cloudflare: { on: "DNS edit", replace: "a token that has Zone → DNS → Edit" },
  // Stage 9 slice 5: the office's approved update PRs.
  github_write: { on: "update pull requests", replace: "a token with Contents and Pull requests: Read and write on the repository" },
};

// A note that says read-only, or the connect-time check's "missing …" list (test-connection.ts) naming the write
// permission. Today that check doesn't probe project_admin_write (no harmless write exists, A6), so the second form only
// fires once a check records it.
const readOnly = (note: string | null) =>
  !!note && ((/read[- ]only/i.test(note) && !/no read[- ]only/i.test(note)) || /missing [^·]*\bproject_admin_write\b/i.test(note));

export function accessHint(provider: string, access: { write: "ok" | "denied"; at: string } | undefined, scopeNote: string | null): AccessHint | null {
  const a = Object.hasOwn(ACTIONS, provider) ? ACTIONS[provider] : undefined;
  if (!a) return null;
  const off: AccessHint = { tone: "off", text: `Actions off: replace it with ${a.replace}` };
  if (access?.write === "ok") return { tone: "ok", text: `Actions on: ${a.on}` };
  if (access?.write === "denied") return off;
  if (provider === "supabase" && readOnly(scopeNote)) return off;
  return { tone: "faint", text: "Actions: not tried yet" };
}
