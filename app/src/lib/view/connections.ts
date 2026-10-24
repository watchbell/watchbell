import { type Provider, PROVIDERS } from "@/lib/providers/info";
import { SECTION_OF_PROVIDER, SECTIONS, type SectionId } from "@/lib/sections";

// 1.2 (spec §7): Connections as a grid of provider tiles grouped by the section each provider turns on. A tile says
// whether the provider is connected (and how many accounts) and whether one of them needs attention.
export type ConnectionTile = { provider: Provider; accounts: number; attention: number };
export type ConnectionGroup = { section: SectionId; title: string; tiles: ConnectionTile[] };

// The sections a provider can belong to, in sidebar order. Manage holds Google Drive (backups), which the page adds
// itself because it is not a provider account.
export const GRID_SECTIONS: { id: SectionId; title: string }[] = (["hosting", "database", "devops"] as const).map((id) => ({
  id,
  title: SECTIONS[id].label,
}));

export function connectionGrid(rows: { provider: string; problem: string | null }[]): ConnectionGroup[] {
  return GRID_SECTIONS.map(({ id, title }) => ({
    section: id,
    title,
    tiles: PROVIDERS.filter((p) => SECTION_OF_PROVIDER[p] === id).map((provider) => {
      const mine = rows.filter((r) => r.provider === provider);
      return { provider, accounts: mine.length, attention: mine.filter((r) => r.problem).length };
    }),
  })).filter((g) => g.tiles.length > 0);
}

export type TileLine = { state: "ok" | "warn" | "err" | "off"; text: string };

// The tile's one line: "Not connected", "Connected", "2 accounts connected", "1 of 2 needs attention".
export function tileLine(t: Pick<ConnectionTile, "accounts" | "attention">): TileLine {
  if (t.accounts === 0) return { state: "off", text: "Not connected" };
  if (t.attention > 0) return { state: "err", text: t.attention === 1 && t.accounts === 1 ? "Needs attention" : `${t.attention} of ${t.accounts} ${t.attention === 1 ? "needs" : "need"} attention` };
  return { state: "ok", text: t.accounts === 1 ? "Connected" : `${t.accounts} accounts connected` };
}

// `?provider=` opens that provider's drawer (a link from elsewhere, e.g. "Connect X first"); anything else opens none.
export function drawerFromQuery(value: string | string[] | undefined): Provider | "drive" | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === "drive") return "drive";
  return v && (PROVIDERS as readonly string[]).includes(v) ? (v as Provider) : null;
}
