import type { ReactNode } from "react";
import { ExternalLink } from "@/components/external-link";
import type { Block, Inline } from "@/lib/github/markdown";
import { cn } from "@/lib/utils";

// The README's parsed tree (lib/github/markdown.ts) as React elements: every text goes through React's escaping, links
// open GitHub in a new tab without a referrer (plain text in demo: ExternalLink), images are lazy and sent no referrer.
// No raw HTML is ever rendered.

const LINK = { target: "_blank", rel: "noopener noreferrer nofollow" } as const;

function inlines(list: Inline[]): ReactNode[] {
  return list.map((n, i) => {
    switch (n.t) {
      case "text": return n.v;
      case "code": return <code key={i} className="rounded bg-sunken px-1 py-px font-mono text-[12.5px]">{n.v}</code>;
      case "em": return <em key={i}>{inlines(n.c)}</em>;
      case "strong": return <strong key={i} className="font-semibold">{inlines(n.c)}</strong>;
      case "del": return <del key={i}>{inlines(n.c)}</del>;
      case "a": return <ExternalLink key={i} href={n.href} {...LINK}>{inlines(n.c)}</ExternalLink>;
      // eslint-disable-next-line @next/next/no-img-element -- remote README images from GitHub hosts only, not optimised
      case "img": return <img key={i} src={n.src} alt={n.alt} loading="lazy" referrerPolicy="no-referrer" className="inline max-w-full align-middle" />;
      case "br": return <br key={i} />;
    }
  });
}

const H = ["text-[22px] border-b border-line pb-1.5", "text-[18px] border-b border-line pb-1", "text-[16px]", "text-[15px]", "text-[14px]", "text-[13px] text-ink-soft"];

function blocks(list: Block[]): ReactNode[] {
  return list.map((b, i) => {
    switch (b.t) {
      case "h": {
        const Tag = `h${b.level}` as "h1";
        return <Tag key={i} className={cn("mb-2 mt-5 font-semibold first:mt-0", H[b.level - 1])}>{inlines(b.c)}</Tag>;
      }
      case "p": return <p key={i} className="my-2.5 leading-relaxed">{inlines(b.c)}</p>;
      case "code": return <pre key={i} className="my-3 overflow-x-auto rounded-md border border-line bg-sunken p-3 font-mono text-[12.5px] leading-snug"><code>{b.text}</code></pre>;
      case "hr": return <hr key={i} className="my-4 border-line" />;
      case "quote": return <blockquote key={i} className="my-3 border-l-[3px] border-line-strong pl-3 text-ink-soft">{blocks(b.c)}</blockquote>;
      case "list": {
        const items = b.items.map((item, k) => <li key={k} className="my-1 [&>p]:my-0">{blocks(item)}</li>);
        return b.ordered
          ? <ol key={i} start={b.start} className="my-2.5 list-decimal pl-6">{items}</ol>
          : <ul key={i} className="my-2.5 list-disc pl-6">{items}</ul>;
      }
      case "table":
        return (
          <div key={i} className="my-3 overflow-x-auto">
            <table className="border-collapse text-[13px]">
              <thead><tr>{b.head.map((c, k) => <th key={k} style={{ textAlign: b.align[k] ?? undefined }} className="border border-line bg-surface-2 px-2.5 py-1.5 font-medium">{inlines(c)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} style={{ textAlign: b.align[j] ?? undefined }} className="border border-line px-2.5 py-1.5 align-top">{inlines(c)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ tree }: { tree: Block[] }) {
  return <div className="min-w-0 break-words text-[14px] [&_a]:text-brand [&_a:hover]:underline">{blocks(tree)}</div>;
}
