"use client";

import { Dialog } from "@base-ui/react/dialog";
import { IconBrandGoogleDrive, IconX } from "@tabler/icons-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useHoldRefresh } from "@/components/live";
import { Status } from "@/components/status";
import type { TileLine } from "@/lib/view/connections";
import { PROVIDER_ICONS } from "./account-dialog";

const ICONS = { ...PROVIDER_ICONS, drive: IconBrandGoogleDrive };

// 1.2 (spec §7): one provider's tile in the Connections grid and the right-side drawer it opens. The drawer's body (the
// accounts with Sync, Test connection, Replace credential and Remove, then the add-account form) is rendered on the
// server and passed in, so the server's revalidation after an add or a removal updates the open drawer in place.
// `?provider=<id>` opens a drawer on load, for links like "Connect Vercel first".
export function ProviderDrawer({
  name, note, icon, line, defaultOpen = false, children,
}: { name: string; note: string; icon: keyof typeof ICONS; line: TileLine; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  // A later navigation to ?provider=<this> (a link clicked while already on Connections) opens it again: React's
  // "adjust state when a prop changes" pattern, no effect.
  const [asked, setAsked] = useState(defaultOpen);
  if (asked !== defaultOpen) {
    setAsked(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  const router = useRouter();
  const pathname = usePathname();
  useHoldRefresh(open);

  // Closing drops ?provider= from the address, so a reload (or the way back from Google's sign-in) doesn't reopen it.
  function change(next: boolean) {
    setOpen(next);
    if (!next && new URLSearchParams(window.location.search).has("provider")) router.replace(pathname, { scroll: false });
  }
  const Icon = ICONS[icon];
  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Trigger
        className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-3 text-left hover:border-line-strong hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        aria-label={`${name}: ${line.text}`}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium text-ink">{name}</span>
          <span className="block text-[12.5px]"><Status state={line.state}>{line.text}</Status></span>
        </span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/10" />
        <Dialog.Popup
          className="fixed inset-y-0 right-0 z-50 flex w-[620px] max-w-full flex-col border-l border-line bg-surface text-ink shadow-lg outline-none"
        >
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-[18px] py-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-semibold">{name}</Dialog.Title>
              <Dialog.Description className="mt-px text-[12.5px] text-ink-soft">{note}</Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              title="Close"
              className="ml-auto inline-grid size-[34px] shrink-0 place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <IconX size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
