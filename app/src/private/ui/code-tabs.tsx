"use client";

import { IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { cn } from "@/lib/utils";

// Copies to the clipboard; the page never sees the text again. A browser that refuses (no permission, insecure
// context) gets a toast saying so instead of a silent nothing.
export async function copyText(text: string, what = "Copied to the clipboard."): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Couldn't copy. Select the text and copy it by hand.");
  }
}

// Comment lines (# ..., // ...) are dimmed, like the mockup's pre.code .c.
const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn("m-0 overflow-x-auto whitespace-pre bg-code-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-code-text", className)}>
      {code.split("\n").map((line, i) => (
        <span key={i} className={cn("block min-h-[1.6em]", isComment(line) && "text-code-dim")}>{line}</span>
      ))}
    </pre>
  );
}

// The mockup's .codetabs: tabs on top, one block, Copy copies the visible tab.
export function CodeTabs({ tabs, label = "Code" }: { tabs: [label: string, code: string][]; label?: string }) {
  const [active, setActive] = useState(0);
  const i = Math.min(active, tabs.length - 1);
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line bg-surface-2 px-1.5" role="tablist" aria-label={label}>
        {tabs.map(([l], n) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={n === i}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 text-[13px] text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              n === i && "border-brand font-medium text-ink",
            )}
            onClick={() => setActive(n)}
          >
            {l}
          </button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={() => copyText(tabs[i][1])}>
          <IconCopy size={15} aria-hidden />Copy
        </Button>
      </div>
      <div role="tabpanel"><CodeBlock code={tabs[i][1]} /></div>
    </div>
  );
}

// The mockup's .prompt-box with its Copy button: a prompt the owner pastes into an agent.
export function PromptBox({ text, copyLabel = "Copy prompt", what = "Prompt copied." }: { text: string; copyLabel?: string; what?: string }) {
  return (
    <>
      <pre className="m-0 mb-2.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-[1.6]">{text}</pre>
      <Button size="sm" onClick={() => copyText(text, what)}><IconCopy size={15} aria-hidden />{copyLabel}</Button>
    </>
  );
}
