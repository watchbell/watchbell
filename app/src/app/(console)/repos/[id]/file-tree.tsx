import { IconFile, IconFileOff, IconFolder, IconLock } from "@tabler/icons-react";
import Link from "next/link";
import { HIDDEN_TEXT } from "@/lib/code/never-read";
import type { TreeNode } from "@/lib/github/browse";
import { cn } from "@/lib/utils";

// Files tab: the repository's tree as native <details> folders (no script needed to expand them). The folders above the
// file in view start open. A file the console never reads (secrets, generated, binary) is listed without a link.

const row = "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-[3px] text-[13px]";

function Node({ node, href, open, current }: { node: TreeNode; href: (path: string) => string; open: Set<string>; current: string | null }) {
  if (node.kind === "dir") {
    if (node.hidden) {
      return <li className={cn(row, "text-ink-faint")} title={HIDDEN_TEXT[node.hidden]}><IconFolder size={15} aria-hidden className="shrink-0" /><span className="truncate">{node.name}/</span><span className="ml-auto shrink-0 text-[11.5px]">{HIDDEN_TEXT[node.hidden]}</span></li>;
    }
    return (
      <li>
        <details open={open.has(node.path)}>
          <summary className={cn(row, "cursor-pointer select-none hover:bg-hover")}><IconFolder size={15} aria-hidden className="shrink-0 text-ink-soft" /><span className="truncate">{node.name}</span></summary>
          <ul className="ml-3 border-l border-line pl-1.5">{node.children.map((c) => <Node key={c.path} node={c} href={href} open={open} current={current} />)}</ul>
        </details>
      </li>
    );
  }
  if (node.hidden) {
    const Icon = node.hidden === "secret" ? IconLock : IconFileOff;
    return <li className={cn(row, "text-ink-faint")} title={HIDDEN_TEXT[node.hidden]}><Icon size={15} aria-hidden className="shrink-0" /><span className="truncate">{node.name}</span><span className="ml-auto shrink-0 text-[11.5px]">{HIDDEN_TEXT[node.hidden]}</span></li>;
  }
  const here = node.path === current;
  return (
    <li>
      <Link href={href(node.path)} aria-current={here ? "page" : undefined} className={cn(row, "text-ink hover:bg-hover", here && "bg-brand-soft text-brand")}>
        <IconFile size={15} aria-hidden className="shrink-0 text-ink-faint" /><span className="truncate">{node.name}</span>
      </Link>
    </li>
  );
}

export function FileTree({ root, href, open, current }: { root: TreeNode; href: (path: string) => string; open: string[]; current: string | null }) {
  const set = new Set(open);
  return <ul className="font-mono">{root.children.map((c) => <Node key={c.path} node={c} href={href} open={set} current={current} />)}</ul>;
}
