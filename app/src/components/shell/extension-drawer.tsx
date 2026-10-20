"use client";

import { Dialog } from "@base-ui/react/dialog";
import { IconBuildingSkyscraper, IconX } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { IconButton } from "@/components/kit";
import type { DrawerLink } from "@/lib/extensions";

// The top bar's extension button, owner only (the layout sends the link to owners alone): a right-side drawer with the
// extension's page in a same-origin iframe. The words come from the extension (DrawerLink). The iframe exists only
// while the drawer is open (the popup unmounts on close), so the framed page polls nothing while it is shut. It
// deliberately does NOT hold the page's refresh (useHoldRefresh): the drawer can stay open for long, and
// router.refresh() keeps its client state.
export function ExtensionDrawer({ link }: { link: DrawerLink }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={link.label} pressed={open} onClick={() => setOpen(true)}><IconBuildingSkyscraper size={18} /></IconButton>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/10" />
          <Dialog.Popup
            aria-describedby={undefined}
            className="fixed inset-y-0 right-0 z-50 flex w-1/2 min-w-[560px] flex-col border-l border-line bg-surface text-ink shadow-lg outline-none max-[900px]:w-full max-[900px]:min-w-0"
          >
            <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
              <Dialog.Title className="text-[15px] font-semibold">{link.title}</Dialog.Title>
              <Link href={link.href} onClick={() => setOpen(false)} className="ml-auto text-[13px] font-medium text-brand hover:underline">{link.openLabel}</Link>
              <Dialog.Close
                aria-label="Close"
                title="Close"
                className="inline-grid size-[34px] place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <IconX size={18} />
              </Dialog.Close>
            </div>
            <iframe src={link.frame} title={link.title} className="min-h-0 w-full flex-1 border-0" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
