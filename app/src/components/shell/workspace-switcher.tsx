"use client";

import { IconCheck, IconSelector } from "@tabler/icons-react";
import { HoverLink as Link } from "@/components/hover-link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { switchWorkspace } from "@/app/(console)/workspaces/actions";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_WORKSPACES, switcherEntries, type WorkspaceLite, workspaceLabel } from "@/lib/workspace/choice";

// Watchbell 1.8 (spec §5): the workspace shown, under the brand in the sidebar header. Choosing one sets a cookie
// (no database write) and refreshes; "All workspaces" opens the overview of every client.
export function WorkspaceSwitcher({ list, current, isOwner }: { list: WorkspaceLite[]; current: string | null; isOwner: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const label = workspaceLabel(list, current);
  const choose = (value: string) => start(async () => {
    const r = await switchWorkspace(value);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (value === ALL_WORKSPACES) router.push("/workspaces");
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Workspace: ${label}. Switch workspace`}
        disabled={pending}
        className="flex w-full min-w-0 items-center gap-1 rounded-md text-left text-xs text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <span className="truncate">{label}</span>
        <IconSelector size={13} stroke={1.75} aria-hidden className="shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
          {switcherEntries(list, current).map((e) => (
            <DropdownMenuItem key={e.value} onClick={() => choose(e.value)} disabled={pending}>
              <span className="flex-1 truncate">{e.label}</span>
              {e.checked && <IconCheck size={14} stroke={2} aria-label="current" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {isOwner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/settings?tab=workspaces" />}>+ New workspace</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
