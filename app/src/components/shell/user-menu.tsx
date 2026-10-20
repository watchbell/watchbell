"use client";

import Link from "next/link";
import { useTransition } from "react";
import { signOut } from "@/app/auth/actions";
import { useMask } from "@/components/alias";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/lib/roles";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", operator: "Operator", viewer: "Viewer" };

// hasPassword: self-host accounts, which can change their password at /account/password.
export function UserMenu({ email, role, hasPassword = false }: { email: string; role: Role; hasPassword?: boolean }) {
  const [pending, start] = useTransition();
  // Screenshot mode hides the signed-in address and its initials.
  const shown = useMask()("email", email);
  const masked = shown !== email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="ml-1 grid size-[30px] place-items-center rounded-full border border-line bg-sunken font-mono text-[11px] font-medium uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {masked ? "··" : email.slice(0, 2)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate">{shown}</span>
            <span className="block text-xs font-normal text-ink-faint">{ROLE_LABEL[role]}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {hasPassword && <DropdownMenuItem render={<Link href="/account/password" />}>Change password</DropdownMenuItem>}
        <DropdownMenuItem className="text-err" disabled={pending} onClick={() => start(() => signOut())}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
