import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { defaultWorkspaceId, listWorkspaces, type Workspace } from "@/lib/data/workspace-db";
import { pickWorkspace, WS_COOKIE } from "./choice";

// Watchbell 1.8 (spec §5): the workspace this request shows (null = All workspaces) and the list, read once per
// request (React cache) by the layout and the page alike. No database write.
export const currentWorkspace = cache(async (): Promise<{ id: string | null; list: Workspace[] }> => {
  const [jar, list] = await Promise.all([cookies(), listWorkspaces()]);
  return { id: pickWorkspace(jar.get(WS_COOKIE)?.value, list), list };
});

// The workspace a per-workspace editor (status page, new report) works on: the one shown, or the default one when
// "All workspaces" is chosen.
export async function workspaceForEditing(): Promise<string> {
  const { id } = await currentWorkspace();
  return id ?? (await defaultWorkspaceId());
}
