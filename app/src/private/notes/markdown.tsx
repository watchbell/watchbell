import { Fragment } from "react";
import { MaskedText } from "@/components/alias";
import { type Block, type Inline, parseMarkdown } from "./markdown-parse";

function Inl({ list }: { list: Inline[] }) {
  return (
    <>
      {list.map((x, i) => (
        <Fragment key={i}>
          {x.t === "b" ? <b className="font-medium"><MaskedText text={x.text} /></b>
            : x.t === "code" ? <code className="rounded bg-sunken px-1 font-mono text-[12.5px]">{x.text}</code>
            : <MaskedText text={x.text} />}
        </Fragment>
      ))}
    </>
  );
}

function Blk({ b }: { b: Block }) {
  if (b.t === "p") return <p className="mt-1.5 first:mt-0"><Inl list={b.inl} /></p>;
  if (b.t === "h") return <p className="mt-2 font-medium first:mt-0"><Inl list={b.inl} /></p>;
  if (b.t === "code") return <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-sunken p-2 font-mono text-[12.5px]">{b.text}</pre>;
  const List = b.t === "ul" ? "ul" : "ol";
  return (
    <List className={`mt-1.5 space-y-0.5 pl-5 ${b.t === "ul" ? "list-disc" : "list-decimal"}`}>
      {b.items.map((it, i) => <li key={i}><Inl list={it} /></li>)}
    </List>
  );
}

// Renders agent-written text. Everything is a React text node (escaped), so raw HTML shows as text and nothing is a link.
export function Markdown({ source }: { source: string }) {
  return <div className="text-[13px]">{parseMarkdown(source).map((b, i) => <Blk key={i} b={b} />)}</div>;
}
