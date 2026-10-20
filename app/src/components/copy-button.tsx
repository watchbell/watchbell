"use client";

import { IconCopy } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/kit";

// A small "Copy" button for a block of text (setup snippets on Settings), handy on a phone where selecting is fiddly.
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  }
  return <Button size="sm" onClick={copy}><IconCopy size={14} aria-hidden /> {label}</Button>;
}
