// Watchbell 1.8 (spec §5): alerts and workspaces. Pure; the data layer says which workspace each alert is in
// (lib/data/workspace-db.ts alertWorkspaceIds), an alert missing from that map is the install's own.

// The chosen workspace's rows plus the install's own (null = every workspace), and how many are elsewhere.
export function filterByWorkspace<T extends { id: string }>(rows: T[], wsOf: Map<string, string>, ws: string | null): { shown: T[]; elsewhere: number } {
  if (ws === null) return { shown: rows, elsewhere: 0 };
  const shown = rows.filter((r) => !wsOf.has(r.id) || wsOf.get(r.id) === ws);
  return { shown, elsewhere: rows.length - shown.length };
}

// "[Kopi Senja] " at the start of an alert's title in notifications, only when the install has several workspaces.
export const workspacePrefix = (name: string | null | undefined, workspaceCount: number): string =>
  name && workspaceCount > 1 ? `[${name}] ` : "";
