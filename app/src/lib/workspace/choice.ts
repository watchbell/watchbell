// Watchbell 1.8 (spec §5): which workspace the console shows, from a per-browser cookie (no database write when
// switching). Shared by the server (layout, pages), the switcher and the tests; only wsCookieOptions reads the
// environment (server only).

export const WS_COOKIE = "wb_ws";
export const ALL_WORKSPACES = "all";

// 1.8.3: Secure exactly when the console's address (SITE_URL) is https, like the session cookie
// (lib/local-auth/session-cookie.ts). By NODE_ENV it was dropped by a self-hosted console opened over plain http on
// the LAN; by the request's scheme it lost Secure behind a TLS proxy.
export function wsCookieOptions(siteUrl: string | undefined = process.env.SITE_URL) {
  // Final review M3: Vercel serves https only, so a cloud deploy stays Secure whatever SITE_URL says.
  let secure = process.env.VERCEL === "1";
  try {
    secure ||= new URL(siteUrl ?? "").protocol === "https:";
  } catch {
    // no or unusable address: not Secure, as for the session cookie
  }
  return { path: "/", sameSite: "lax" as const, httpOnly: true, maxAge: 60 * 60 * 24 * 365, secure };
}

export type WorkspaceLite = { id: string; name: string };

// null = All workspaces. A cookie naming a deleted or unknown workspace falls back to the first one; with a single
// workspace "All" means that one (there is nothing else to show).
export function pickWorkspace(cookie: string | undefined, list: WorkspaceLite[]): string | null {
  if (!list.length) return null;
  if (cookie === ALL_WORKSPACES) return list.length > 1 ? null : list[0].id;
  return list.find((w) => w.id === cookie)?.id ?? list[0].id;
}

export type SwitcherEntry = { value: string; label: string; checked: boolean };

// The switcher's menu: the workspaces (check on the current one), then All workspaces when there are several.
export function switcherEntries(list: WorkspaceLite[], current: string | null): SwitcherEntry[] {
  const items = list.map((w) => ({ value: w.id, label: w.name, checked: w.id === current }));
  return list.length > 1 ? [...items, { value: ALL_WORKSPACES, label: "All workspaces", checked: current === null }] : items;
}

export const workspaceLabel = (list: WorkspaceLite[], current: string | null): string =>
  current === null ? "All workspaces" : (list.find((w) => w.id === current)?.name ?? list[0]?.name ?? "Personal");
