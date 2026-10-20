"use client";

import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { Snippet } from "./snippets";

// The mockup's .codetabs: a row of tabs with Copy on the right, one code block below.
export function SnippetTabs({ snippets }: { snippets: Snippet[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const shown = snippets[Math.min(active, snippets.length - 1)];

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it.");
    }
  }

  return (
    <div className="mt-1 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line bg-surface-2 px-1.5" role="tablist" aria-label="Snippet language">
        {snippets.map((s, i) => (
          <button
            key={s.label}
            type="button"
            role="tab"
            id={`${id}-t${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-p`}
            onClick={() => setActive(i)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 text-[13px] text-ink-soft",
              i === active && "border-brand font-medium text-ink",
            )}
          >
            {s.label}
          </button>
        ))}
        <Button size="sm" className="my-1 ml-auto" onClick={copy}>
          {copied ? <IconCheck size={14} aria-hidden /> : <IconCopy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre id={`${id}-p`} role="tabpanel" aria-labelledby={`${id}-t${active}`} tabIndex={0} className="m-0 overflow-x-auto bg-code-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-code-text">
        {shown.code}
      </pre>
    </div>
  );
}
